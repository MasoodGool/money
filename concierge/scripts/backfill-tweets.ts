/**
 * Historical tweet backfill — ANALYSIS ONLY, never places an order.
 *
 *   npm run backfill:tweets            # last TWEET_BACKFILL_DAYS (default 30)
 *   npm run backfill:tweets -- --days 14
 *
 * Reads the account's timeline for the window, classifies every tweet with
 * the analyst model, and records what the pipeline WOULD have done. This is
 * the calibration pass: it tells you how many calls the account actually
 * makes, how the confidence/conviction gates behave against real text, and
 * where the classifier is wrong — before any of it is wired to real money.
 *
 * It deliberately cannot trade. Acting on a tweet from three weeks ago means
 * entering at a price that has already moved; the freshness gate exists for
 * exactly that reason, and a backfill that "caught up" on a month of calls
 * would be a month of bad fills in one burst.
 */

import { loadConfig } from "../src/config.js";
import { LogNotifier } from "../src/notifier.js";
import { Executor } from "../src/executor.js";
import { InMemoryStore } from "../src/store.js";
import { ClaudeTweetAnalyzer } from "../src/tweets/analyzer.js";
import { TweetPoller } from "../src/tweets/poller.js";
import { TweetRouter } from "../src/tweets/router.js";
import { aliasesOf, buildSymbolMap } from "../src/tweets/symbols.js";
import { SqliteTweetLog } from "../src/tweets/tweet-log.js";
import { XApiTweetSource } from "../src/tweets/x-source.js";
import type { ExecutionVenue, MarketFilters, OcoBracket, OrderReceipt } from "../src/venue.js";

/** A venue that cannot trade. Any call here is a bug in the paper path. */
class NoTradeVenue implements ExecutionVenue {
  private fail(op: string): never {
    throw new Error(`backfill is analysis-only; ${op} must never be called`);
  }
  async getFilters(): Promise<MarketFilters> {
    return { amountStep: 0, priceTick: 0, minNotional: undefined };
  }
  async getPrice(): Promise<number> {
    this.fail("getPrice");
  }
  async roundAmount(_s: string, a: number): Promise<number> {
    return a;
  }
  async roundPrice(_s: string, p: number): Promise<number> {
    return p;
  }
  async marketBuy(): Promise<OrderReceipt> {
    this.fail("marketBuy");
  }
  async marketSell(): Promise<OrderReceipt> {
    this.fail("marketSell");
  }
  async placeOcoSell(_s: string, _a: number, _b: OcoBracket): Promise<OrderReceipt> {
    this.fail("placeOcoSell");
  }
  async cancelOrder(): Promise<void> {
    this.fail("cancelOrder");
  }
  async isOrderOpen(): Promise<boolean> {
    return false;
  }
}

function argDays(fallback: number): number {
  const i = process.argv.indexOf("--days");
  if (i === -1) return fallback;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const missing: string[] = [];
  if (!config.tweets.xBearerToken) missing.push("X_BEARER_TOKEN");
  if (!config.tweets.anthropicApiKey) missing.push("ANTHROPIC_API_KEY");
  if (missing.length > 0) {
    console.error(
      `Cannot backfill: missing ${missing.join(" and ")}.\n` +
        `  X_BEARER_TOKEN   — X API v2 app token. Reading a user timeline\n` +
        `                     (GET /2/users/:id/tweets) requires a PAID tier;\n` +
        `                     the free tier cannot read timelines.\n` +
        `  ANTHROPIC_API_KEY — analyst model that classifies each tweet.`
    );
    process.exit(1);
  }

  const days = argDays(config.tweets.backfillDays);
  const symbols = buildSymbolMap(config.tweets.assets);
  const tweetLog = new SqliteTweetLog(config.tweets.tweetDbPath);

  const router = new TweetRouter({
    // A real Executor wired to a venue that throws: the paper path must never
    // reach the exchange, and this proves it rather than assuming it.
    executor: new Executor({
      venue: new NoTradeVenue(),
      notifier: new LogNotifier(() => undefined),
      risk: config.risk,
      killSwitch: true,
      store: new InMemoryStore(),
    }),
    analyzer: new ClaudeTweetAnalyzer({
      apiKey: config.tweets.anthropicApiKey,
      model: config.tweets.analystModel,
      aliases: aliasesOf(symbols),
    }),
    prices: new NoTradeVenue(),
    notifier: new LogNotifier(() => undefined),
    store: new InMemoryStore(),
    tweetLog,
    config: {
      symbols,
      minConfidence: config.tweets.minConfidence,
      minConviction: config.tweets.minConviction,
      // Historical tweets are all "stale" by definition; the paper path stops
      // before the freshness gate, so widen it to keep the report meaningful.
      maxTweetAgeMinutes: Number.POSITIVE_INFINITY,
      allowSpeculative: config.tweets.allowSpeculative,
    },
  });

  const poller = new TweetPoller({
    source: new XApiTweetSource({
      handle: config.tweets.handle,
      bearerToken: config.tweets.xBearerToken,
    }),
    router,
    store: new InMemoryStore(),
    notifier: new LogNotifier(),
    pollSeconds: config.tweets.pollSeconds,
  });

  console.log(`Backfilling @${config.tweets.handle}: last ${days} day(s), analysis only.`);
  const summary = await poller.backfill(days);

  console.log("\n=== Backfill summary ===");
  console.log(`  tweets read     : ${summary.tweets}`);
  console.log(`  actionable calls: ${summary.actionable}`);
  console.log(`    would enter   : ${summary.wouldEnter}`);
  console.log(`    would exit    : ${summary.wouldExit}`);
  console.log(`  not a call      : ${summary.ignored}`);
  console.log(`  filtered/other  : ${summary.skipped - summary.actionable}`);
  console.log(`\nEvery tweet and its classification is in ${config.tweets.tweetDbPath}.`);

  const calls = tweetLog
    .byMode("paper")
    .filter((r) => r.analysis?.actionable)
    .slice(-20);
  if (calls.length > 0) {
    console.log("\n=== Most recent actionable calls ===");
    for (const c of calls) {
      const a = c.analysis!;
      console.log(
        `  ${c.tweetCreatedAt}  ${a.action.toUpperCase().padEnd(5)} ${(a.asset ?? "?").padEnd(8)}` +
          ` conf=${a.confidence.toFixed(2)} ${a.conviction.padEnd(6)} -> ${describe(c.decision)}`
      );
      console.log(`      "${c.text.replace(/\s+/g, " ").slice(0, 140)}"`);
    }
  }
  console.log(
    "\nNo orders were placed. Review the classifications above, tune " +
      "TWEET_MIN_CONFIDENCE / TWEET_MIN_CONVICTION / TWEET_ASSETS, then arm the live feed."
  );
}

function describe(d: { action: string; reason?: string; detail?: string }): string {
  return d.reason ?? d.detail ?? d.action;
}

main().catch((err) => {
  console.error(`Backfill failed: ${(err as Error).message}`);
  process.exit(1);
});
