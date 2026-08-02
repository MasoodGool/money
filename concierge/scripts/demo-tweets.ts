/**
 * Offline end-to-end demo of the tweet pipeline — no API keys, no broker.
 *
 *   npm run demo:tweets
 *
 * Runs representative tweets — written in the style @TradexWhisperer actually
 * posts, i.e. US equity calls — through the real TweetRouter, the real market
 * gate and the real Executor against an in-memory venue. You see exactly which
 * tweets become orders and which get filtered, and why.
 *
 * The analyst is a crude keyword stub here (the real one is Claude); with
 * ANTHROPIC_API_KEY set it uses the real analyst instead, which is the honest
 * way to see how the classifier behaves on your own example text.
 */

import { Executor } from "../src/executor.js";
import { LogNotifier } from "../src/notifier.js";
import { InMemoryStore } from "../src/store.js";
import { ClaudeTweetAnalyzer, inertAnalysis } from "../src/tweets/analyzer.js";
import { DayTradeLedger } from "../src/tweets/day-trade-ledger.js";
import { AlpacaMarketGate } from "../src/tweets/market-gate.js";
import { TweetRouter } from "../src/tweets/router.js";
import { aliasesOf, buildEquitySymbolMap, DEFAULT_EQUITY_ASSETS } from "../src/tweets/symbols.js";
import { NoopTweetLog } from "../src/tweets/types.js";
import type { Tweet, TweetAnalysis, TweetAnalyzer } from "../src/tweets/types.js";
import type { ExecutionVenue, MarketFilters, OcoBracket, OrderReceipt } from "../src/venue.js";

/** Stand-in last-trade prices; the demo never touches a real market. */
const PRICES: Record<string, number> = { MU: 62, PLTR: 21, RKLB: 10, SNDK: 214, NVDA: 178 };

class DemoVenue implements ExecutionVenue {
  // Equities: whole shares, one-cent tick, no exchange minimum notional.
  async getFilters(): Promise<MarketFilters> {
    return { amountStep: 1, priceTick: 0.01, minNotional: undefined };
  }
  async getPrice(symbol: string): Promise<number> {
    const p = PRICES[symbol];
    if (!p) throw new Error(`no demo price for ${symbol}`);
    return p;
  }
  async roundAmount(_s: string, a: number): Promise<number> {
    return Math.floor(a);
  }
  async roundPrice(_s: string, p: number): Promise<number> {
    return Math.round(p * 100) / 100;
  }
  async marketBuy(_s: string, amount: number): Promise<OrderReceipt> {
    return { id: "demo-buy", amount, price: PRICES[_s] };
  }
  async marketSell(_s: string, amount: number): Promise<OrderReceipt> {
    return { id: "demo-sell", amount, price: PRICES[_s] };
  }
  async placeOcoSell(_s: string, amount: number, b: OcoBracket): Promise<OrderReceipt> {
    return { id: "demo-oco", amount, price: b.takeProfitPrice };
  }
  async cancelOrder(): Promise<void> {}
  async isOrderOpen(): Promise<boolean> {
    return true;
  }
}

/** Keyword stand-in for the model, so the demo runs with no credentials. */
class KeywordAnalyzer implements TweetAnalyzer {
  constructor(private readonly aliases: string[]) {}
  async analyze(tweet: Tweet): Promise<TweetAnalysis> {
    const text = tweet.text.toLowerCase();
    const asset = this.aliases.find((a) =>
      new RegExp(`(^|[^a-z0-9])\\$?${a}([^a-z0-9]|$)`).test(text)
    );
    if (!asset) return inertAnalysis("no tradable asset mentioned");
    const buy = /\b(long|longing|buying|bought|entry|accumulating)\b/.test(text);
    const sell = /\b(out of|closing|closed|taking profit|short|shorting|exit)\b/.test(text);
    const speculative = /\b(could|might|maybe|watching|eyeing|if)\b/.test(text);
    if (!buy && !sell) return inertAnalysis("no directional call");
    return {
      actionable: true,
      action: sell ? "sell" : "buy",
      asset,
      conviction: speculative ? "low" : "high",
      confidence: speculative ? 0.5 : 0.9,
      timeHorizon: "swing",
      speculative,
      rationale: `keyword stub read a ${sell ? "sell" : "buy"} on ${asset}`,
    };
  }
}

const MINUTE = 60_000;
const now = Date.now();

function tweet(id: string, text: string, minutesAgo = 1): Tweet {
  return {
    id: `19000000000000000${id.padStart(2, "0")}`,
    text,
    createdAt: new Date(now - minutesAgo * MINUTE).toISOString(),
    authorHandle: "TradexWhisperer",
    isRetweet: false,
    isReply: false,
    url: `https://x.com/TradexWhisperer/status/${id}`,
  };
}

const FIXTURES: Tweet[] = [
  tweet("01", "Semiconductor export data out tomorrow. Should be informative."),
  tweet("02", "Bargain thesis: buying $MU at 62. DRAM bit demand inflecting."),
  tweet("03", "Buying more $MU here, adding to the position."),
  tweet("04", "$GME about to squeeze again, you know what to do."),
  tweet("05", "$NVDA could run to 250 if hyperscaler capex holds. Watching."),
  tweet("06", "Taking profit, out of $MU."),
  tweet("07", "Bought $PLTR at 21, stop under 19.", 240),
];

async function main(): Promise<void> {
  const symbols = buildEquitySymbolMap(DEFAULT_EQUITY_ASSETS);
  const aliases = aliasesOf(symbols);
  const key = process.env["ANTHROPIC_API_KEY"] ?? "";
  const analyzer: TweetAnalyzer = key
    ? new ClaudeTweetAnalyzer({ apiKey: key, aliases })
    : new KeywordAnalyzer(aliases);

  const venue = new DemoVenue();
  const notifier = new LogNotifier(() => undefined);
  const executor = new Executor({
    venue,
    notifier,
    risk: {
      equity: 10000,
      riskPerTrade: 0.01,
      maxPositionPct: 0.2,
      dailyLossLimit: 0.03,
      stopLossPct: 0.05,
      stopLimitOffsetPct: 0.005,
      takeProfitPct: 0.08,
    },
    // Armed on purpose: the venue is in-memory, so nothing can reach an
    // exchange, and the point is to watch the risk gate actually fire.
    killSwitch: false,
    quoteCurrency: "USD",
    store: new InMemoryStore(),
  });

  // The real Alpaca gate, fed a stubbed clock and account: open market,
  // comfortable equity, so the demo exercises the gate without a broker.
  const gateStore = new InMemoryStore();
  const marketGate = new AlpacaMarketGate({
    venue: {
      getClock: async () => ({ isOpen: true, nextOpen: "", nextClose: "" }),
      getAccount: async () => ({
        equity: 50_000,
        patternDayTrader: false,
        tradingBlocked: false,
        accountBlocked: false,
      }),
    },
    ledger: new DayTradeLedger(gateStore),
  });

  const router = new TweetRouter({
    executor,
    analyzer,
    prices: venue,
    notifier,
    store: new InMemoryStore(),
    tweetLog: new NoopTweetLog(),
    marketGate,
    config: {
      symbols,
      minConfidence: 0.75,
      minConviction: "medium",
      maxTweetAgeMinutes: 30,
      allowSpeculative: false,
      quoteCurrency: "USD",
    },
  });

  console.log(`Analyst: ${key ? "Claude (live)" : "keyword stub (set ANTHROPIC_API_KEY for the real one)"}`);
  console.log(
    `Venue alpaca (simulated) · equity 10 000 USD · 1% risk · 5% stop\n` +
      `Allowlist: ${DEFAULT_EQUITY_ASSETS.join(", ")} · market open, 50k equity (no PDT limit)\n`
  );

  for (const t of FIXTURES) {
    const decision = await router.process(t);
    const detail =
      "detail" in decision ? decision.detail : "reason" in decision ? decision.reason : "";
    console.log(`"${t.text}"`);
    console.log(`   → ${decision.action.toUpperCase()}: ${detail}\n`);
  }

  const open = executor.getOpenPositions();
  console.log(
    open.length === 0
      ? "No open positions at the end of the run."
      : `Open positions: ${open.map((p) => `${p.symbol} (${p.amount} shares)`).join(", ")}`
  );
  console.log(
    "\nLive, two more gates apply that this demo hard-codes as open: the market\n" +
      "must be in session (US equities close overnight), and a sub-$25k account\n" +
      "must have day-trade headroom under the pattern-day-trader rule."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
