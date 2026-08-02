import { describe, expect, it } from "vitest";

import type { AlpacaAccount, AlpacaClock } from "../src/alpaca-venue.js";
import { InMemoryStore } from "../src/store.js";
import { DayTradeLedger, tradingDate } from "../src/tweets/day-trade-ledger.js";
import { AlpacaMarketGate, AlwaysOpenGate } from "../src/tweets/market-gate.js";

const NOW = new Date("2026-08-03T15:00:00Z"); // Monday, 11:00 ET — market open

function account(over: Partial<AlpacaAccount> = {}): AlpacaAccount {
  return {
    equity: 50_000,
    patternDayTrader: false,
    tradingBlocked: false,
    accountBlocked: false,
    ...over,
  };
}

function clock(over: Partial<AlpacaClock> = {}): AlpacaClock {
  return {
    isOpen: true,
    nextOpen: "2026-08-04T13:30:00Z",
    nextClose: "2026-08-03T20:00:00Z",
    ...over,
  };
}

function makeGate(opts: {
  account?: AlpacaAccount;
  clock?: AlpacaClock;
  store?: InMemoryStore;
} = {}) {
  const store = opts.store ?? new InMemoryStore();
  const ledger = new DayTradeLedger(store);
  const gate = new AlpacaMarketGate({
    venue: {
      getAccount: async () => opts.account ?? account(),
      getClock: async () => opts.clock ?? clock(),
    },
    ledger,
    now: () => NOW,
  });
  return { gate, ledger, store };
}

describe("AlwaysOpenGate", () => {
  it("permits everything — crypto has no hours and no PDT rule", async () => {
    const gate = new AlwaysOpenGate();
    expect(await gate.canEnter()).toEqual({ ok: true });
    expect(await gate.canExit()).toEqual({ ok: true });
  });
});

describe("AlpacaMarketGate — market hours", () => {
  it("allows an entry while the market is open", async () => {
    const { gate } = makeGate();
    expect(await gate.canEnter()).toEqual({ ok: true });
  });

  it("refuses an entry when the market is closed, naming the next open", async () => {
    const { gate } = makeGate({ clock: clock({ isOpen: false }) });

    const decision = await gate.canEnter();

    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/market closed until 2026-08-04T13:30:00Z/);
  });

  it("refuses an exit when the market is closed, noting the bracket still holds", async () => {
    const { gate } = makeGate({ clock: clock({ isOpen: false }) });

    const decision = await gate.canExit();

    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/bracket still protecting/);
  });
});

describe("AlpacaMarketGate — pattern day trader", () => {
  it("refuses entries once the broker has flagged a small account", async () => {
    const { gate } = makeGate({
      account: account({ equity: 12_000, patternDayTrader: true }),
    });

    const decision = await gate.canEnter();

    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/flagged pattern-day-trader/);
  });

  it("ignores the PDT flag above the equity floor", async () => {
    const { gate } = makeGate({
      account: account({ equity: 30_000, patternDayTrader: true }),
    });

    expect(await gate.canEnter()).toEqual({ ok: true });
  });

  it("refuses a fourth day trade on a small account", async () => {
    const { gate, ledger } = makeGate({ account: account({ equity: 10_000 }) });
    for (let i = 0; i < 3; i++) {
      ledger.recordClose(NOW.toISOString(), NOW);
    }

    const decision = await gate.canEnter();

    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/day-trade limit reached \(3\/3/);
  });

  it("still allows the third day trade", async () => {
    const { gate, ledger } = makeGate({ account: account({ equity: 10_000 }) });
    ledger.recordClose(NOW.toISOString(), NOW);
    ledger.recordClose(NOW.toISOString(), NOW);

    expect(await gate.canEnter()).toEqual({ ok: true });
  });

  it("never blocks an exit for the day-trade limit", async () => {
    // Refusing to close would leave real risk on the book to protect a
    // compliance counter — exactly backwards.
    const { gate, ledger } = makeGate({ account: account({ equity: 10_000 }) });
    for (let i = 0; i < 5; i++) ledger.recordClose(NOW.toISOString(), NOW);

    expect(await gate.canExit()).toEqual({ ok: true });
  });

  it("does not apply the day-trade limit above the equity floor", async () => {
    const { gate, ledger } = makeGate({ account: account({ equity: 100_000 }) });
    for (let i = 0; i < 9; i++) ledger.recordClose(NOW.toISOString(), NOW);

    expect(await gate.canEnter()).toEqual({ ok: true });
  });
});

describe("AlpacaMarketGate — broker blocks", () => {
  it("refuses both directions when the broker blocks the account", async () => {
    const { gate } = makeGate({ account: account({ accountBlocked: true }) });

    expect((await gate.canEnter()).reason).toMatch(/blocked this account/);
    expect((await gate.canExit()).reason).toMatch(/blocked this account/);
  });

  it("refuses when the broker blocks trading specifically", async () => {
    const { gate } = makeGate({ account: account({ tradingBlocked: true }) });

    expect((await gate.canEnter()).reason).toMatch(/blocked trading/);
  });
});

describe("DayTradeLedger", () => {
  const store = () => new InMemoryStore();

  it("counts a same-day round trip", () => {
    const ledger = new DayTradeLedger(store());

    expect(ledger.recordClose(NOW.toISOString(), NOW)).toBe(true);
    expect(ledger.count(NOW)).toBe(1);
  });

  it("does not count an overnight hold", () => {
    const ledger = new DayTradeLedger(store());
    const yesterday = new Date(NOW.getTime() - 86_400_000).toISOString();

    expect(ledger.recordClose(yesterday, NOW)).toBe(false);
    expect(ledger.count(NOW)).toBe(0);
  });

  it("ignores a position with no recorded entry time", () => {
    // Positions written before opened_at existed: treated as overnight holds
    // rather than assumed to be day trades.
    const ledger = new DayTradeLedger(store());

    expect(ledger.recordClose(undefined, NOW)).toBe(false);
    expect(ledger.recordClose("not-a-date", NOW)).toBe(false);
  });

  it("drops day trades that have aged out of the window", () => {
    const s = store();
    const ledger = new DayTradeLedger(s);
    const old = new Date(NOW.getTime() - 10 * 86_400_000);
    ledger.recordClose(old.toISOString(), old);

    expect(ledger.count(old)).toBe(1);
    expect(ledger.count(NOW)).toBe(0);
  });

  it("survives a corrupt ledger value without wedging trading", () => {
    const s = store();
    s.setSetting("day_trades", "{not json");
    const ledger = new DayTradeLedger(s);

    expect(ledger.count(NOW)).toBe(0);
    expect(ledger.recordClose(NOW.toISOString(), NOW)).toBe(true);
    expect(ledger.count(NOW)).toBe(1);
  });

  it("persists across instances, since a restart must not reset the count", () => {
    const s = store();
    new DayTradeLedger(s).recordClose(NOW.toISOString(), NOW);

    expect(new DayTradeLedger(s).count(NOW)).toBe(1);
  });

  it("uses the exchange timezone, not UTC, to decide the trading day", () => {
    // 01:00 UTC on the 4th is still the evening of the 3rd in New York.
    const lateUtc = new Date("2026-08-04T01:00:00Z");
    expect(tradingDate(lateUtc)).toBe("2026-08-03");
    expect(tradingDate(lateUtc, "UTC")).toBe("2026-08-04");
  });
});
