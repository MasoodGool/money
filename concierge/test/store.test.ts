import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RiskConfig } from "../src/config.js";
import { Executor } from "../src/executor.js";
import type { Notifier } from "../src/notifier.js";
import { SqliteStore } from "../src/sqlite-store.js";
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
  openOrderIds = new Set<string>();
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
    return { id: "buy-1", amount, price: 100 };
  }
  async marketSell(_s: string, amount: number): Promise<OrderReceipt> {
    return { id: "sell-1", amount, price: 100 };
  }
  async placeOcoSell(_s: string, amount: number, b: OcoBracket): Promise<OrderReceipt> {
    this.openOrderIds.add("oco-1");
    return { id: "oco-1", amount, price: b.takeProfitPrice };
  }
  async cancelOrder(): Promise<void> {}
  async isOrderOpen(_s: string, id: string): Promise<boolean> {
    return this.openOrderIds.has(id);
  }
}

const notifier: Notifier = { notify: async () => {} };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "concierge-store-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function dbPath() {
  return join(dir, "state.sqlite");
}

describe("SqliteStore persistence across restarts", () => {
  it("resumes open positions and idempotency after a restart", async () => {
    const venue = new FakeVenue();

    // First process lifetime: open a position.
    {
      const store = new SqliteStore(dbPath());
      const ex = new Executor({ venue, notifier, risk: RISK, killSwitch: false, store });
      await ex.handleEntry({ type: "entry", trade_id: "100", pair: "SOL/USDT", rate: 100 });
      expect(ex.getOpenPositions()).toHaveLength(1);
    }

    // New process: a fresh Executor on the same DB file must see the position
    // and refuse to re-handle the same trade_id.
    {
      const store = new SqliteStore(dbPath());
      const ex = new Executor({ venue, notifier, risk: RISK, killSwitch: false, store });
      expect(ex.getOpenPositions()).toHaveLength(1);
      const dup = await ex.handleEntry({ type: "entry", trade_id: "100", pair: "SOL/USDT", rate: 100 });
      expect(dup.action).toBe("skipped");
    }
  });

  it("persists runtime kill-switch and equity changes", () => {
    {
      const store = new SqliteStore(dbPath());
      const ex = new Executor({ venue: new FakeVenue(), notifier, risk: RISK, killSwitch: false, store });
      ex.setKillSwitch(true);
      ex.setEquity(25000);
    }
    {
      const store = new SqliteStore(dbPath());
      // killSwitch:false from config, but the persisted "true" must win.
      const ex = new Executor({ venue: new FakeVenue(), notifier, risk: RISK, killSwitch: false, store });
      expect(ex.isKillSwitchOn()).toBe(true);
      expect(ex.getEquity()).toBe(25000);
    }
  });
});

describe("reconcileOnBoot", () => {
  it("drops a position whose protective bracket resolved while offline", async () => {
    const venue = new FakeVenue();
    const store = new SqliteStore(dbPath());
    const ex = new Executor({ venue, notifier, risk: RISK, killSwitch: false, store });
    await ex.handleEntry({ type: "entry", trade_id: "7", pair: "SOL/USDT", rate: 100 });
    expect(ex.getOpenPositions()).toHaveLength(1);

    // Simulate the OCO filling (TP or SL) while the bot was down.
    venue.openOrderIds.delete("oco-1");

    const store2 = new SqliteStore(dbPath());
    const ex2 = new Executor({ venue, notifier, risk: RISK, killSwitch: false, store: store2 });
    await ex2.reconcileOnBoot();
    expect(ex2.getOpenPositions()).toHaveLength(0);
  });

  it("keeps a position whose bracket is still resting", async () => {
    const venue = new FakeVenue();
    const store = new SqliteStore(dbPath());
    const ex = new Executor({ venue, notifier, risk: RISK, killSwitch: false, store });
    await ex.handleEntry({ type: "entry", trade_id: "8", pair: "SOL/USDT", rate: 100 });

    const store2 = new SqliteStore(dbPath());
    const ex2 = new Executor({ venue, notifier, risk: RISK, killSwitch: false, store: store2 });
    await ex2.reconcileOnBoot(); // oco-1 still open
    expect(ex2.getOpenPositions()).toHaveLength(1);
  });
});
