import { describe, expect, it, vi } from "vitest";

import type { RiskConfig } from "../src/config.js";
import { Executor } from "../src/executor.js";
import type { Notifier } from "../src/notifier.js";
import type {
  ExecutionVenue,
  MarketFilters,
  OcoBracket,
  OrderReceipt,
} from "../src/venue.js";

const RISK: RiskConfig = {
  equity: 10000,
  riskPerTrade: 0.01,
  maxPositionPct: 0.2,
  dailyLossLimit: 0.03,
  stopLossPct: 0.05,
  stopLimitOffsetPct: 0.005,
  takeProfitPct: 0.08,
};

/** In-memory venue recording calls; rounds to 3dp / 2dp like a typical pair. */
class FakeVenue implements ExecutionVenue {
  filters: MarketFilters = { amountStep: 0.001, priceTick: 0.01, minNotional: 10 };
  buys: Array<{ symbol: string; amount: number }> = [];
  sells: Array<{ symbol: string; amount: number }> = [];
  ocos: Array<{ symbol: string; amount: number; bracket: OcoBracket }> = [];
  cancels: string[] = [];
  buyPrice = 100;
  sellPrice = 100;
  ocoShouldFail = false;

  async getFilters(): Promise<MarketFilters> {
    return this.filters;
  }
  async roundAmount(_s: string, a: number): Promise<number> {
    return Math.floor(a * 1000) / 1000;
  }
  async roundPrice(_s: string, p: number): Promise<number> {
    return Math.round(p * 100) / 100;
  }
  async marketBuy(symbol: string, amount: number): Promise<OrderReceipt> {
    this.buys.push({ symbol, amount });
    return { id: `buy-${this.buys.length}`, amount, price: this.buyPrice };
  }
  async marketSell(symbol: string, amount: number): Promise<OrderReceipt> {
    this.sells.push({ symbol, amount });
    return { id: `sell-${this.sells.length}`, amount, price: this.sellPrice };
  }
  async placeOcoSell(symbol: string, amount: number, bracket: OcoBracket): Promise<OrderReceipt> {
    if (this.ocoShouldFail) throw new Error("oco rejected");
    this.ocos.push({ symbol, amount, bracket });
    return { id: `oco-${this.ocos.length}`, amount, price: bracket.takeProfitPrice };
  }
  async cancelOrder(_s: string, id: string): Promise<void> {
    this.cancels.push(id);
  }
}

function makeNotifier(): Notifier & { messages: string[] } {
  const messages: string[] = [];
  return { messages, notify: async (m: string) => void messages.push(m) };
}

function entry(tradeId: string, rate = 100) {
  return { type: "entry", trade_id: tradeId, pair: "SOL/USDT", rate };
}

describe("Executor.handleEntry — autonomous", () => {
  it("sizes, buys, and places a protective OCO bracket", async () => {
    const venue = new FakeVenue();
    const notifier = makeNotifier();
    const ex = new Executor({ venue, notifier, risk: RISK, killSwitch: false });

    const out = await ex.handleEntry(entry("1", 100));

    expect(out.action).toBe("placed");
    // 1% of 10000 = 100 risk; stop distance = 100*0.05 = 5 => 20 base, capped
    // by maxPosition 20% = 2000 notional => 20 base. Both give 20 here.
    expect(venue.buys).toEqual([{ symbol: "SOL/USDT", amount: 20 }]);
    expect(venue.ocos).toHaveLength(1);
    const b = venue.ocos[0]!.bracket;
    expect(b.stopPrice).toBeCloseTo(95, 2);
    expect(b.takeProfitPrice).toBeCloseTo(108, 2);
    expect(ex.getOpenPositions()).toHaveLength(1);
  });

  it("does NOT require confirmation (places immediately)", async () => {
    const venue = new FakeVenue();
    const ex = new Executor({ venue, notifier: makeNotifier(), risk: RISK, killSwitch: false });
    await ex.handleEntry(entry("1"));
    expect(venue.buys).toHaveLength(1); // no human gate
  });

  it("kill switch suppresses all orders (notify only)", async () => {
    const venue = new FakeVenue();
    const notifier = makeNotifier();
    const ex = new Executor({ venue, notifier, risk: RISK, killSwitch: true });

    const out = await ex.handleEntry(entry("1"));
    expect(out.action).toBe("skipped");
    expect(venue.buys).toHaveLength(0);
    expect(notifier.messages.join()).toMatch(/kill switch/i);
  });

  it("is idempotent: a duplicate trade_id does not double-buy", async () => {
    const venue = new FakeVenue();
    const ex = new Executor({ venue, notifier: makeNotifier(), risk: RISK, killSwitch: false });
    await ex.handleEntry(entry("42"));
    const second = await ex.handleEntry(entry("42"));
    expect(second.action).toBe("skipped");
    expect(venue.buys).toHaveLength(1);
  });

  it("rejects when notional rounds below the exchange minimum", async () => {
    const venue = new FakeVenue();
    venue.filters = { amountStep: 0.001, priceTick: 0.01, minNotional: 5000 };
    const ex = new Executor({ venue, notifier: makeNotifier(), risk: RISK, killSwitch: false });
    const out = await ex.handleEntry(entry("1"));
    expect(out.action).toBe("skipped");
    expect(venue.buys).toHaveLength(0);
  });

  it("keeps the position but warns loudly if the OCO bracket fails", async () => {
    const venue = new FakeVenue();
    venue.ocoShouldFail = true;
    const notifier = makeNotifier();
    const ex = new Executor({ venue, notifier, risk: RISK, killSwitch: false });

    const out = await ex.handleEntry(entry("1"));
    expect(out.action).toBe("placed");
    expect(venue.buys).toHaveLength(1);
    expect(notifier.messages.join()).toMatch(/UNPROTECTED/);
  });
});

describe("Executor — daily-loss circuit breaker", () => {
  it("suppresses entries once the daily realized loss hits the limit", async () => {
    const venue = new FakeVenue();
    const ex = new Executor({ venue, notifier: makeNotifier(), risk: RISK, killSwitch: false });

    // Open #1 then exit at a loss big enough to breach 3% of 10000 = 300.
    await ex.handleEntry(entry("1", 100));
    venue.sellPrice = 80; // 20 base * (80-100) = -400 realized
    await ex.handleExit({ type: "exit", trade_id: "1", pair: "SOL/USDT", rate: 80 });
    expect(ex.remainingDailyBudget()).toBe(0);

    const blocked = await ex.handleEntry(entry("2", 100));
    expect(blocked.action).toBe("skipped");
    if (blocked.action === "skipped") expect(blocked.reason).toMatch(/daily loss/i);
    expect(venue.buys).toHaveLength(1); // only the first entry ever bought
  });

  it("resets the daily window at 00:00 SAST", async () => {
    const venue = new FakeVenue();
    let now = new Date("2026-06-13T10:00:00Z"); // 12:00 SAST
    const ex = new Executor({
      venue,
      notifier: makeNotifier(),
      risk: RISK,
      killSwitch: false,
      now: () => now,
    });

    await ex.handleEntry(entry("1", 100));
    venue.sellPrice = 80;
    await ex.handleExit({ type: "exit", trade_id: "1", pair: "SOL/USDT", rate: 80 });
    expect(ex.remainingDailyBudget()).toBe(0);

    // Cross midnight SAST -> next day; budget restores.
    now = new Date("2026-06-13T22:30:00Z"); // 00:30 SAST on the 14th
    expect(ex.remainingDailyBudget()).toBeCloseTo(300, 6);
    const out = await ex.handleEntry(entry("2", 100));
    expect(out.action).toBe("placed");
  });
});

describe("Executor.handleExit", () => {
  it("cancels the resting OCO then market-sells to close", async () => {
    const venue = new FakeVenue();
    const ex = new Executor({ venue, notifier: makeNotifier(), risk: RISK, killSwitch: false });
    await ex.handleEntry(entry("7", 100));

    venue.sellPrice = 110;
    const out = await ex.handleExit({ type: "exit", trade_id: "7", pair: "SOL/USDT", rate: 110 });

    expect(out.action).toBe("closed");
    if (out.action === "closed") expect(out.realizedQuote).toBeCloseTo(20 * 10, 6); // +200
    expect(venue.cancels).toEqual(["oco-1"]);
    expect(venue.sells).toHaveLength(1);
    expect(ex.getOpenPositions()).toHaveLength(0);
  });

  it("skips an exit for an unknown trade_id", async () => {
    const venue = new FakeVenue();
    const ex = new Executor({ venue, notifier: makeNotifier(), risk: RISK, killSwitch: false });
    const out = await ex.handleExit({ type: "exit", trade_id: "999", pair: "SOL/USDT", rate: 1 });
    expect(out.action).toBe("skipped");
    expect(venue.sells).toHaveLength(0);
  });
});

// Silence intentional console noise from the default notifier, if any.
vi.spyOn(console, "log").mockImplementation(() => {});
