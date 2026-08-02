import { describe, expect, it, vi } from "vitest";

import type { RiskConfig } from "../src/config.js";
import { Executor } from "../src/executor.js";
import type { Notifier } from "../src/notifier.js";
import { InMemoryStore } from "../src/store.js";
import type { MarketGate } from "../src/tweets/market-gate.js";
import { TweetRouter, tradeIdFor } from "../src/tweets/router.js";
import { buildSymbolMap } from "../src/tweets/symbols.js";
import { NoopTweetLog } from "../src/tweets/types.js";
import type {
  PriceSource,
  Tweet,
  TweetAnalysis,
  TweetAnalyzer,
  TweetLog,
  TweetLogRecord,
} from "../src/tweets/types.js";
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

const CONFIG = {
  symbols: buildSymbolMap(["BTC", "ETH", "SOL"]),
  minConfidence: 0.75,
  minConviction: "medium" as const,
  maxTweetAgeMinutes: 30,
  allowSpeculative: false,
};

const NOW = new Date("2026-08-02T12:00:00Z");

function tweet(over: Partial<Tweet> = {}): Tweet {
  return {
    id: "1900000000000000001",
    text: "longing SOL here",
    createdAt: new Date(NOW.getTime() - 60_000).toISOString(),
    authorHandle: "TradexWhisperer",
    isRetweet: false,
    isReply: false,
    url: "https://x.com/TradexWhisperer/status/1900000000000000001",
    ...over,
  };
}

function analysis(over: Partial<TweetAnalysis> = {}): TweetAnalysis {
  return {
    actionable: true,
    action: "buy",
    asset: "SOL",
    conviction: "high",
    confidence: 0.9,
    timeHorizon: "swing",
    speculative: false,
    rationale: "explicit long call",
    ...over,
  };
}

function fixedAnalyzer(a: TweetAnalysis | Error): TweetAnalyzer {
  return {
    analyze: vi.fn(async () => {
      if (a instanceof Error) throw a;
      return a;
    }),
  };
}

function makeNotifier(): Notifier & { messages: string[] } {
  const messages: string[] = [];
  return { messages, notify: async (m: string) => void messages.push(m) };
}

function recordingLog(): TweetLog & { records: TweetLogRecord[] } {
  const records: TweetLogRecord[] = [];
  return { records, record: (r) => void records.push(r) };
}

const prices: PriceSource = { getPrice: async () => 150 };

/** Executor stub that records dispatches without touching a venue. */
function stubExecutor(
  openPositions: Array<{ tradeId: string; symbol: string; openedAt?: string }> = []
) {
  const entries: Array<{ tradeId: string; pair: string; rate: number }> = [];
  const exits: Array<{ tradeId: string; pair: string }> = [];
  const stub = {
    getOpenPositions: () =>
      openPositions.map((p) => ({
        amount: 1,
        entryPrice: 100,
        stopPrice: 95,
        ocoOrderId: "oco-1",
        openedAt: p.openedAt ?? NOW.toISOString(),
        ...p,
      })),
    handleEntry: vi.fn(async (s: { trade_id: string; pair: string; rate: number }) => {
      entries.push({ tradeId: s.trade_id, pair: s.pair, rate: s.rate });
      return { action: "placed" as const, tradeId: s.trade_id, amount: 1, stakeQuote: 150 };
    }),
    handleExit: vi.fn(async (s: { trade_id: string; pair: string }) => {
      exits.push({ tradeId: s.trade_id, pair: s.pair });
      return { action: "closed" as const, tradeId: s.trade_id, realizedQuote: 12.5 };
    }),
  };
  return { executor: stub as unknown as Executor, entries, exits, raw: stub };
}

function makeRouter(opts: {
  analysis?: TweetAnalysis | Error;
  open?: Array<{ tradeId: string; symbol: string; openedAt?: string }>;
  config?: Partial<typeof CONFIG>;
  store?: InMemoryStore;
  prices?: PriceSource;
  marketGate?: MarketGate;
}) {
  const { executor, entries, exits, raw } = stubExecutor(opts.open);
  const notifier = makeNotifier();
  const tweetLog = recordingLog();
  const store = opts.store ?? new InMemoryStore();
  const router = new TweetRouter({
    executor,
    analyzer: fixedAnalyzer(opts.analysis ?? analysis()),
    prices: opts.prices ?? prices,
    notifier,
    store,
    tweetLog,
    ...(opts.marketGate ? { marketGate: opts.marketGate } : {}),
    config: { ...CONFIG, ...opts.config },
    now: () => NOW,
  });
  return { router, entries, exits, notifier, tweetLog, store, raw };
}

describe("TweetRouter — gates", () => {
  it("places an entry for a fresh, confident call on an allowlisted asset", async () => {
    const { router, entries } = makeRouter({});

    const decision = await router.process(tweet());

    expect(decision.action).toBe("entered");
    expect(entries).toEqual([
      { tradeId: tradeIdFor("1900000000000000001"), pair: "SOL/USDT", rate: 150 },
    ]);
  });

  it("ignores tweets the analyst did not read as a call", async () => {
    const { router, entries } = makeRouter({
      analysis: analysis({ actionable: false, action: "none", rationale: "commentary" }),
    });

    expect(await router.process(tweet())).toEqual({
      action: "ignored",
      reason: "commentary",
    });
    expect(entries).toHaveLength(0);
  });

  it("refuses assets outside the allowlist", async () => {
    const { router, entries } = makeRouter({
      analysis: analysis({ asset: "PEPE" }),
    });

    const decision = await router.process(tweet({ text: "aping PEPE" }));

    expect(decision).toMatchObject({ action: "ignored" });
    expect((decision as { reason: string }).reason).toMatch(/not in the traded allowlist/);
    expect(entries).toHaveLength(0);
  });

  it("skips entries below the confidence floor", async () => {
    const { router, entries } = makeRouter({ analysis: analysis({ confidence: 0.5 }) });

    const decision = await router.process(tweet());

    expect((decision as { reason: string }).reason).toMatch(/confidence 0.50 below 0.75/);
    expect(entries).toHaveLength(0);
  });

  it("skips entries below the conviction floor", async () => {
    const { router, entries } = makeRouter({ analysis: analysis({ conviction: "low" }) });

    expect((await router.process(tweet())) as { reason: string }).toMatchObject({
      action: "skipped",
    });
    expect(entries).toHaveLength(0);
  });

  it("skips speculative musings unless explicitly allowed", async () => {
    const spec = analysis({ speculative: true });
    const blocked = makeRouter({ analysis: spec });
    expect((await blocked.router.process(tweet())).action).toBe("skipped");
    expect(blocked.entries).toHaveLength(0);

    const allowed = makeRouter({ analysis: spec, config: { allowSpeculative: true } });
    expect((await allowed.router.process(tweet())).action).toBe("entered");
  });

  it("never chases a stale call", async () => {
    const { router, entries } = makeRouter({});
    const old = tweet({ createdAt: new Date(NOW.getTime() - 3 * 3600_000).toISOString() });

    const decision = await router.process(old);

    expect((decision as { reason: string }).reason).toMatch(/180m old \(max 30m\)/);
    expect(entries).toHaveLength(0);
  });

  it("treats an unparseable timestamp as infinitely stale", async () => {
    const { router, entries } = makeRouter({});
    expect((await router.process(tweet({ createdAt: "not-a-date" }))).action).toBe("skipped");
    expect(entries).toHaveLength(0);
  });

  it("holds at most one position per symbol", async () => {
    const { router, entries } = makeRouter({
      open: [{ tradeId: "tw-999", symbol: "SOL/USDT" }],
    });

    const decision = await router.process(tweet());

    expect((decision as { reason: string }).reason).toMatch(/already holding SOL\/USDT/);
    expect(entries).toHaveLength(0);
  });

  it("skips when the venue cannot price the symbol, and says so", async () => {
    const { router, entries, notifier } = makeRouter({
      prices: {
        getPrice: async () => {
          throw new Error("exchange unreachable");
        },
      },
    });

    const decision = await router.process(tweet());

    expect((decision as { reason: string }).reason).toMatch(/exchange unreachable/);
    expect(entries).toHaveLength(0);
    expect(notifier.messages.join()).toMatch(/could not price/);
  });

  it("skips a non-positive price rather than sizing off it", async () => {
    const { router, entries } = makeRouter({ prices: { getPrice: async () => 0 } });
    expect((await router.process(tweet())).action).toBe("skipped");
    expect(entries).toHaveLength(0);
  });
});

describe("TweetRouter — exits", () => {
  it("closes the matching open position on a sell call", async () => {
    const { router, exits } = makeRouter({
      analysis: analysis({ action: "sell", asset: "SOL", conviction: "low", confidence: 0.4 }),
      open: [{ tradeId: "tw-42", symbol: "SOL/USDT" }],
    });

    const decision = await router.process(tweet({ text: "out of SOL" }));

    // Exits bypass the quality floors on purpose: closing risk should not be
    // blocked by a hedged-sounding tweet.
    expect(decision.action).toBe("exited");
    expect(exits).toEqual([{ tradeId: "tw-42", pair: "SOL/USDT" }]);
  });

  it("ignores a bearish call when nothing is held (spot is long-only)", async () => {
    const { router, exits } = makeRouter({
      analysis: analysis({ action: "sell" }),
      open: [],
    });

    const decision = await router.process(tweet({ text: "shorting SOL" }));

    expect((decision as { reason: string }).reason).toMatch(/no open SOL\/USDT position/);
    expect(exits).toHaveLength(0);
  });
});

describe("TweetRouter — bookkeeping", () => {
  it("processes a tweet exactly once", async () => {
    const store = new InMemoryStore();
    const first = makeRouter({ store });
    await first.router.process(tweet());

    const second = makeRouter({ store });
    const decision = await second.router.process(tweet());

    expect(decision).toEqual({ action: "skipped", reason: "already processed" });
    expect(second.entries).toHaveLength(0);
  });

  it("logs every tweet it reads, traded or not", async () => {
    const { router, tweetLog } = makeRouter({
      analysis: analysis({ actionable: false, action: "none" }),
    });

    await router.process(tweet());

    expect(tweetLog.records).toHaveLength(1);
    expect(tweetLog.records[0]).toMatchObject({
      tweetId: "1900000000000000001",
      mode: "live",
      decision: { action: "ignored" },
    });
    expect(tweetLog.records[0]!.analysis).not.toBeNull();
  });

  it("alerts when a real call is not taken", async () => {
    const { router, notifier } = makeRouter({ analysis: analysis({ confidence: 0.1 }) });

    await router.process(tweet());

    expect(notifier.messages.join()).toMatch(/Tweet call NOT taken/);
  });

  it("stays silent about ordinary commentary", async () => {
    const { router, notifier } = makeRouter({
      analysis: analysis({ actionable: false, action: "none" }),
    });

    await router.process(tweet());

    expect(notifier.messages).toHaveLength(0);
  });

  it("surfaces an analysis failure instead of dropping the tweet", async () => {
    const { router, notifier, tweetLog, entries } = makeRouter({
      analysis: new Error("anthropic 529"),
    });

    const decision = await router.process(tweet());

    expect((decision as { reason: string }).reason).toMatch(/analysis failed: anthropic 529/);
    expect(notifier.messages.join()).toMatch(/anthropic 529/);
    expect(tweetLog.records).toHaveLength(1);
    expect(entries).toHaveLength(0);
  });

  it("resolves assets written as pairs or with a $ prefix", async () => {
    for (const asset of ["$btc", "BTC/USDT", "BTCUSDT", "Bitcoin"]) {
      const { router, entries } = makeRouter({ analysis: analysis({ asset }) });
      await router.process(tweet());
      expect(entries[0]?.pair, `asset ${asset}`).toBe("BTC/USDT");
    }
  });
});

describe("TweetRouter — market gate", () => {
  function gate(over: Partial<MarketGate> = {}): MarketGate & { closes: string[] } {
    const closes: string[] = [];
    return {
      closes,
      canEnter: async () => ({ ok: true }),
      canExit: async () => ({ ok: true }),
      recordClose: (openedAt) => void closes.push(openedAt ?? "none"),
      ...over,
    };
  }

  it("refuses an entry when the venue says it cannot trade", async () => {
    const { router, entries } = makeRouter({
      marketGate: gate({
        canEnter: async () => ({ ok: false, reason: "market closed until 13:30Z" }),
      }),
    });

    const decision = await router.process(tweet());

    expect((decision as { reason: string }).reason).toBe("market closed until 13:30Z");
    expect(entries).toHaveLength(0);
  });

  it("refuses an exit when the venue says it cannot trade", async () => {
    const { router, exits } = makeRouter({
      analysis: analysis({ action: "close" }),
      open: [{ tradeId: "tw-42", symbol: "SOL/USDT" }],
      marketGate: gate({ canExit: async () => ({ ok: false, reason: "market closed" }) }),
    });

    const decision = await router.process(tweet({ text: "out of SOL" }));

    expect((decision as { reason: string }).reason).toBe("market closed");
    expect(exits).toHaveLength(0);
  });

  it("treats an unreachable gate as closed rather than assuming open", async () => {
    const { router, entries } = makeRouter({
      marketGate: gate({
        canEnter: async () => {
          throw new Error("alpaca 503");
        },
      }),
    });

    const decision = await router.process(tweet());

    expect((decision as { reason: string }).reason).toMatch(/market gate unavailable: alpaca 503/);
    expect(entries).toHaveLength(0);
  });

  it("reports a close so it can count against the day-trade allowance", async () => {
    const g = gate();
    const openedAt = "2026-08-02T09:30:00.000Z";
    const { router } = makeRouter({
      analysis: analysis({ action: "close" }),
      open: [{ tradeId: "tw-42", symbol: "SOL/USDT", openedAt }],
      marketGate: g,
    });

    await router.process(tweet({ text: "out of SOL" }));

    expect(g.closes).toEqual([openedAt]);
  });

  it("does not consult the gate in paper mode", async () => {
    // Paper is an offline analysis pass; it must not need broker access.
    const g = gate({
      canEnter: async () => {
        throw new Error("should not be called");
      },
    });
    const { router } = makeRouter({ marketGate: g });

    expect((await router.process(tweet(), "paper")).action).toBe("skipped");
  });
});

describe("TweetRouter — paper mode", () => {
  it("places no orders and leaves no durable state", async () => {
    const store = new InMemoryStore();
    const { router, entries, exits } = makeRouter({ store });

    const decision = await router.process(tweet(), "paper");

    expect((decision as { reason: string }).reason).toMatch(/paper mode — would BUY SOL\/USDT/);
    expect(entries).toHaveLength(0);
    expect(exits).toHaveLength(0);
    expect(store.isHandled("tweet:1900000000000000001")).toBe(false);
  });

  it("reports would-be exits too", async () => {
    const { router } = makeRouter({
      analysis: analysis({ action: "close" }),
      open: [{ tradeId: "tw-42", symbol: "SOL/USDT" }],
    });

    const decision = await router.process(tweet(), "paper");

    expect((decision as { reason: string }).reason).toMatch(/would CLOSE SOL\/USDT/);
  });
});

/** Venue that fills predictably, to prove the risk gate still applies. */
class FakeVenue implements ExecutionVenue {
  buys: Array<{ symbol: string; amount: number }> = [];
  async getFilters(): Promise<MarketFilters> {
    return { amountStep: 0.001, priceTick: 0.01, minNotional: 10 };
  }
  async getPrice(): Promise<number> {
    return 150;
  }
  async roundAmount(_s: string, a: number): Promise<number> {
    return Math.floor(a * 1000) / 1000;
  }
  async roundPrice(_s: string, p: number): Promise<number> {
    return Math.round(p * 100) / 100;
  }
  async marketBuy(symbol: string, amount: number): Promise<OrderReceipt> {
    this.buys.push({ symbol, amount });
    return { id: "buy-1", amount, price: 150 };
  }
  async marketSell(_s: string, amount: number): Promise<OrderReceipt> {
    return { id: "sell-1", amount, price: 150 };
  }
  async placeOcoSell(_s: string, amount: number, b: OcoBracket): Promise<OrderReceipt> {
    return { id: "oco-1", amount, price: b.takeProfitPrice };
  }
  async cancelOrder(): Promise<void> {}
  async isOrderOpen(): Promise<boolean> {
    return true;
  }
}

describe("TweetRouter — end to end through the real Executor", () => {
  function build(killSwitch: boolean) {
    const venue = new FakeVenue();
    const notifier = makeNotifier();
    const executor = new Executor({
      venue,
      notifier,
      risk: RISK,
      killSwitch,
      store: new InMemoryStore(),
    });
    const router = new TweetRouter({
      executor,
      analyzer: fixedAnalyzer(analysis()),
      prices: venue,
      notifier,
      store: new InMemoryStore(),
      tweetLog: new NoopTweetLog(),
      config: CONFIG,
      now: () => NOW,
    });
    return { router, venue, notifier };
  }

  it("sizes by the 1% rule and brackets the position", async () => {
    const { router, venue } = build(false);

    const decision = await router.process(tweet());

    expect(decision.action).toBe("entered");
    // 1% of 10 000 risked over a 5% stop = 2 000 notional, clamped by the 20%
    // max position (2 000) => 13.333 SOL at 150.
    expect(venue.buys[0]).toMatchObject({ symbol: "SOL/USDT" });
    expect(venue.buys[0]!.amount).toBeCloseTo(13.333, 3);
  });

  it("places nothing while the kill switch is engaged", async () => {
    const { router, venue, notifier } = build(true);

    const decision = await router.process(tweet());

    expect(decision.action).toBe("skipped");
    expect(venue.buys).toHaveLength(0);
    expect(notifier.messages.join()).toMatch(/kill switch/);
  });
});
