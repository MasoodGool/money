import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RiskConfig } from "../src/config.js";
import { Executor } from "../src/executor.js";
import { SqliteJournal, type JournalRow } from "../src/journal.js";
import { summarize } from "../src/report.js";
import type { ExecutionVenue, MarketFilters, OcoBracket, OrderReceipt } from "../src/venue.js";

const RISK: RiskConfig = {
  equity: 10000,
  riskPerTrade: 0.01,
  maxPositionPct: 0.2,
  dailyLossLimit: 0.03,
  stopLossPct: 0.05,
  stopLimitOffsetPct: 0.005,
  takeProfitPct: 0.08,
};

class FakeVenue implements ExecutionVenue {
  buyPrice = 100.5;
  sellPrice = 110;
  async getFilters(): Promise<MarketFilters> {
    return { amountStep: 0.001, priceTick: 0.01, minNotional: 10 };
  }
  async roundAmount(_s: string, a: number): Promise<number> {
    return Math.floor(a * 1000) / 1000;
  }
  async roundPrice(_s: string, p: number): Promise<number> {
    return Math.round(p * 100) / 100;
  }
  async marketBuy(_s: string, amount: number): Promise<OrderReceipt> {
    return { id: "b", amount, price: this.buyPrice };
  }
  async marketSell(_s: string, amount: number): Promise<OrderReceipt> {
    return { id: "s", amount, price: this.sellPrice };
  }
  async placeOcoSell(_s: string, amount: number, b: OcoBracket): Promise<OrderReceipt> {
    return { id: "oco", amount, price: b.takeProfitPrice };
  }
  async cancelOrder(): Promise<void> {}
  async isOrderOpen(): Promise<boolean> {
    return true;
  }
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "concierge-journal-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("SqliteJournal via the executor", () => {
  it("records entry, exit, and skip rows", async () => {
    const journal = new SqliteJournal(join(dir, "j.sqlite"));
    const venue = new FakeVenue();
    const ex = new Executor({
      venue,
      notifier: { notify: async () => {} },
      risk: RISK,
      killSwitch: false,
      journal,
    });

    await ex.handleEntry({ type: "entry", trade_id: "1", pair: "SOL/USDT", rate: 100 });
    await ex.handleExit({ type: "exit", trade_id: "1", pair: "SOL/USDT", rate: 110 });
    // A skip: stop at entry => risk rejects.
    await ex.handleEntry({ type: "entry", trade_id: "2", pair: "SOL/USDT", rate: 0 });

    const rows = journal.all();
    const kinds = rows.map((r: JournalRow) => r.kind).sort();
    expect(kinds).toEqual(["entry", "exit", "skip"]);

    const entry = rows.find((r) => r.kind === "entry")!;
    expect(entry.signalPrice).toBe(100);
    expect(entry.fillPrice).toBe(100.5); // captured slippage vs 100 signal
    const exit = rows.find((r) => r.kind === "exit")!;
    // 20 base * (sell 110 − entry fill 100.5) = 190
    expect(exit.realizedQuote).toBeCloseTo(20 * 9.5, 6);
  });

  it("marks fills reconciled", () => {
    const journal = new SqliteJournal(join(dir, "j2.sqlite"));
    journal.record({
      ts: new Date().toISOString(),
      tradeId: "9",
      symbol: "BTC/USDT",
      kind: "entry",
      status: "placed",
      signalPrice: 100,
      fillPrice: 100.2,
      amount: 1,
      stakeQuote: 100,
      realizedQuote: null,
      reason: null,
    });
    const pending = journal.unreconciledFills();
    expect(pending).toHaveLength(1);
    journal.markReconciled(pending[0]!.id, 100.25);
    expect(journal.unreconciledFills()).toHaveLength(0);
    expect(journal.all()[0]!.realFillPrice).toBe(100.25);
  });
});

describe("summarize (report maths)", () => {
  const base = {
    symbol: "SOL/USDT",
    status: "x",
    amount: 1,
    stakeQuote: 100,
    realFillPrice: null,
    reconciled: 0,
  };
  const rows: JournalRow[] = [
    { id: 1, ts: "t", tradeId: "1", kind: "entry", signalPrice: 100, fillPrice: 100.1, realizedQuote: null, reason: null, ...base },
    { id: 2, ts: "t", tradeId: "1", kind: "exit", signalPrice: 110, fillPrice: 110, realizedQuote: 9, reason: null, ...base },
    { id: 3, ts: "t", tradeId: "2", kind: "entry", signalPrice: 100, fillPrice: 100.3, realizedQuote: null, reason: null, ...base },
    { id: 4, ts: "t", tradeId: "2", kind: "exit", signalPrice: 90, fillPrice: 90, realizedQuote: -5, reason: null, ...base },
    { id: 5, ts: "t", tradeId: "3", kind: "skip", signalPrice: 100, fillPrice: null, realizedQuote: null, reason: "kill switch engaged", ...base },
  ];

  it("computes counts, P&L, win/loss, slippage, and skip reasons", () => {
    const s = summarize(rows, 6);
    expect(s.entries).toBe(2);
    expect(s.exits).toBe(2);
    expect(s.skips).toBe(1);
    expect(s.realizedQuote).toBeCloseTo(4, 6); // 9 - 5
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(1);
    expect(s.entrySlippage.count).toBe(2);
    // (10bps + 30bps)/2 = 20bps mean
    expect(s.entrySlippage.meanBps).toBeCloseTo(20, 5);
    expect(s.skipReasons["kill switch engaged"]).toBe(1);
    expect(s.paperRealizedQuote).toBe(6);
    // 2 entries + 2 exits all carry fills and are unreconciled.
    expect(s.unreconciledFills).toBe(4);
  });
});
