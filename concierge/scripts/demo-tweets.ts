/**
 * Offline end-to-end demo of the tweet pipeline — no API keys, no exchange.
 *
 *   npm run demo:tweets
 *
 * Runs a handful of representative tweets through the real TweetRouter and
 * the real Executor against an in-memory venue, so you can see exactly which
 * tweets become orders and which get filtered, and why. Useful for sanity-
 * checking gate settings before paying for X API access.
 *
 * The analyst is a crude keyword stub here (the real one is Claude); with
 * ANTHROPIC_API_KEY set it uses the real analyst instead, which is the honest
 * way to see how the classifier behaves on your own example text.
 */

import { Executor } from "../src/executor.js";
import { LogNotifier } from "../src/notifier.js";
import { InMemoryStore } from "../src/store.js";
import { ClaudeTweetAnalyzer, inertAnalysis } from "../src/tweets/analyzer.js";
import { TweetRouter } from "../src/tweets/router.js";
import { aliasesOf, buildSymbolMap } from "../src/tweets/symbols.js";
import { NoopTweetLog } from "../src/tweets/types.js";
import type { Tweet, TweetAnalysis, TweetAnalyzer } from "../src/tweets/types.js";
import type { ExecutionVenue, MarketFilters, OcoBracket, OrderReceipt } from "../src/venue.js";

const PRICES: Record<string, number> = { "BTC/USDT": 61000, "ETH/USDT": 3200, "SOL/USDT": 150 };

class DemoVenue implements ExecutionVenue {
  async getFilters(): Promise<MarketFilters> {
    return { amountStep: 0.001, priceTick: 0.01, minNotional: 10 };
  }
  async getPrice(symbol: string): Promise<number> {
    const p = PRICES[symbol];
    if (!p) throw new Error(`no demo price for ${symbol}`);
    return p;
  }
  async roundAmount(_s: string, a: number): Promise<number> {
    return Math.floor(a * 1000) / 1000;
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
  tweet("01", "gm everyone. market structure looking interesting into the weekend."),
  tweet("02", "Longing $SOL here. Invalidation below the range low."),
  tweet("03", "Longing $SOL again, adding to the position."),
  tweet("04", "$PEPE about to send, don't say I didn't warn you."),
  tweet("05", "BTC could run to 70k if this holds. Watching closely."),
  tweet("06", "Taking profit, out of $SOL."),
  tweet("07", "Bought $ETH at 3200, stop under 3050.", 240),
];

async function main(): Promise<void> {
  const symbols = buildSymbolMap(["BTC", "ETH", "SOL"]);
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
    store: new InMemoryStore(),
  });

  const router = new TweetRouter({
    executor,
    analyzer,
    prices: venue,
    notifier,
    store: new InMemoryStore(),
    tweetLog: new NoopTweetLog(),
    config: {
      symbols,
      minConfidence: 0.75,
      minConviction: "medium",
      maxTweetAgeMinutes: 30,
      allowSpeculative: false,
    },
  });

  console.log(`Analyst: ${key ? "Claude (live)" : "keyword stub (set ANTHROPIC_API_KEY for the real one)"}`);
  console.log(`Equity 10 000 USDT · 1% risk · 5% stop · allowlist BTC/ETH/SOL\n`);

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
      : `Open positions: ${open.map((p) => `${p.symbol} (${p.amount})`).join(", ")}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
