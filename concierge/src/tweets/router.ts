/**
 * TweetRouter: decides what a classified tweet means for the account, and
 * hands the decision to the Executor.
 *
 * Everything the analyst model says is treated as untrusted input. The gates
 * below are the boundary between "a tweet said something" and "real money
 * moves", and they run in this order:
 *
 *   1. idempotency   — one decision per tweet, ever (live mode)
 *   2. actionable    — the model must have read a real call, not commentary
 *   3. allowlist     — the asset must map to a pair we permit (never trade an
 *                      arbitrary ticker a tweet names)
 *   4. quality       — confidence / conviction floors, speculation filter
 *   5. freshness     — a stale call is a dead call; never chase old tweets
 *   6. exposure      — at most one open position per symbol
 *
 * Only then does the Executor see it, where the 1% sizing rule, the daily-loss
 * breaker, the kill switch and the OCO bracket still apply unchanged. This
 * router can only ever *narrow* what the executor would do.
 *
 * Spot long-only: a bearish call cannot open a short. It can only close a
 * position we already hold, and is otherwise recorded and ignored.
 */

import type { Executor } from "../executor.js";
import type { Notifier } from "../notifier.js";
import type { StateStore } from "../store.js";
import type {
  PriceSource,
  Tweet,
  TweetAnalysis,
  TweetAnalyzer,
  TweetDecision,
  TweetLog,
  TweetLogRecord,
} from "./types.js";

export interface TweetRouterConfig {
  /** lowercase alias -> exchange pair, e.g. { btc: "BTC/USDT" }. */
  symbols: Record<string, string>;
  /** Minimum model confidence (0..1) to act. */
  minConfidence: number;
  /** Minimum conviction the tweet must express to act. */
  minConviction: "low" | "medium" | "high";
  /** Reject calls older than this. A tweet-driven entry chases the price. */
  maxTweetAgeMinutes: number;
  /** Act on speculative/predictive tweets. Off by default. */
  allowSpeculative: boolean;
}

export interface TweetRouterDeps {
  executor: Executor;
  analyzer: TweetAnalyzer;
  prices: PriceSource;
  notifier: Notifier;
  store: StateStore;
  tweetLog: TweetLog;
  config: TweetRouterConfig;
  now?: () => Date;
}

const CONVICTION_RANK: Record<"low" | "medium" | "high", number> = {
  low: 0,
  medium: 1,
  high: 2,
};

/** Idempotency key namespace — distinct from the executor's own trade ids. */
function seenKey(tweetId: string): string {
  return `tweet:${tweetId}`;
}

/** Trade id the executor sees for a tweet-driven position. */
export function tradeIdFor(tweetId: string): string {
  return `tw-${tweetId}`;
}

export class TweetRouter {
  private readonly d: TweetRouterDeps;
  private readonly now: () => Date;

  constructor(deps: TweetRouterDeps) {
    this.d = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Process one tweet.
   *
   * `mode: "paper"` is analysis-only: it classifies and logs, places no
   * orders, and touches no durable state beyond the tweet log. This is what
   * the historical backfill runs — a month-old call cannot be traded, only
   * measured.
   */
  async process(tweet: Tweet, mode: "live" | "paper" = "live"): Promise<TweetDecision> {
    if (mode === "live" && this.d.store.isHandled(seenKey(tweet.id))) {
      return this.log(tweet, mode, null, {
        action: "skipped",
        reason: "already processed",
      });
    }

    let analysis: TweetAnalysis;
    try {
      analysis = await this.d.analyzer.analyze(tweet);
    } catch (err) {
      // Never swallow an analysis failure: an unread tweet is a missed
      // signal, and silence would look identical to "nothing was said".
      const reason = `analysis failed: ${(err as Error).message}`;
      await this.d.notifier.notify(`⚠️ Tweet ${tweet.url}: ${reason}`);
      return this.log(tweet, mode, null, { action: "skipped", reason });
    }

    const decision = await this.decide(tweet, analysis, mode);
    return this.log(tweet, mode, analysis, decision);
  }

  private async decide(
    tweet: Tweet,
    analysis: TweetAnalysis,
    mode: "live" | "paper"
  ): Promise<TweetDecision> {
    if (!analysis.actionable) {
      return { action: "ignored", reason: analysis.rationale || "not an actionable call" };
    }

    const symbol = this.resolveSymbol(analysis.asset);
    if (!symbol) {
      return {
        action: "ignored",
        reason: `asset ${analysis.asset ?? "?"} is not in the traded allowlist`,
      };
    }

    // Quality gates apply to entries only. An exit signal on a position we
    // already hold is protective — a low-confidence "I'm out of BTC" should
    // still be able to close risk, and the bracket covers us either way.
    const wantsExit = analysis.action === "sell" || analysis.action === "close";

    if (!wantsExit) {
      if (analysis.confidence < this.d.config.minConfidence) {
        return {
          action: "skipped",
          reason: `confidence ${analysis.confidence.toFixed(2)} below ${this.d.config.minConfidence}`,
        };
      }
      if (
        CONVICTION_RANK[analysis.conviction] <
        CONVICTION_RANK[this.d.config.minConviction]
      ) {
        return {
          action: "skipped",
          reason: `conviction ${analysis.conviction} below ${this.d.config.minConviction}`,
        };
      }
      if (analysis.speculative && !this.d.config.allowSpeculative) {
        return { action: "skipped", reason: "speculative/predictive, not a firm call" };
      }
    }

    const ageMinutes = this.ageMinutes(tweet);
    if (ageMinutes > this.d.config.maxTweetAgeMinutes) {
      return {
        action: "skipped",
        reason: `tweet is ${Math.round(ageMinutes)}m old (max ${this.d.config.maxTweetAgeMinutes}m)`,
      };
    }

    const open = this.d.executor.getOpenPositions().find((p) => p.symbol === symbol);

    if (wantsExit) {
      if (!open) {
        return { action: "ignored", reason: `no open ${symbol} position to close` };
      }
      if (mode === "paper") {
        return { action: "skipped", reason: `paper mode — would CLOSE ${symbol}` };
      }
      this.d.store.markHandled(seenKey(tweet.id));
      const outcome = await this.d.executor.handleExit({
        type: "exit",
        trade_id: open.tradeId,
        pair: symbol,
        rate: await this.priceOr(symbol, open.entryPrice),
      });
      return outcome.action === "closed"
        ? {
            action: "exited",
            symbol,
            tradeId: open.tradeId,
            detail: `realized ${outcome.realizedQuote.toFixed(2)} USDT`,
          }
        : { action: "skipped", reason: outcome.reason };
    }

    if (open) {
      return {
        action: "skipped",
        reason: `already holding ${symbol} (trade ${open.tradeId})`,
      };
    }

    if (mode === "paper") {
      return { action: "skipped", reason: `paper mode — would BUY ${symbol}` };
    }

    // The tweet carries no price, so the entry is marked to the live market.
    let price: number;
    try {
      price = await this.d.prices.getPrice(symbol);
    } catch (err) {
      const reason = `could not price ${symbol}: ${(err as Error).message}`;
      await this.d.notifier.notify(`⚠️ Tweet ${tweet.url}: ${reason}`);
      return { action: "skipped", reason };
    }
    if (!Number.isFinite(price) || price <= 0) {
      return { action: "skipped", reason: `unusable ${symbol} price (${price})` };
    }

    const tradeId = tradeIdFor(tweet.id);
    this.d.store.markHandled(seenKey(tweet.id));
    const outcome = await this.d.executor.handleEntry({
      type: "entry",
      trade_id: tradeId,
      pair: symbol,
      rate: price,
    });
    return outcome.action === "placed"
      ? {
          action: "entered",
          symbol,
          tradeId,
          detail: `${outcome.amount} @ ~${price} (${outcome.stakeQuote.toFixed(2)} USDT)`,
        }
      : { action: "skipped", reason: outcome.reason };
  }

  /** Best-effort live price, falling back to a known reference on failure. */
  private async priceOr(symbol: string, fallback: number): Promise<number> {
    try {
      const p = await this.d.prices.getPrice(symbol);
      return Number.isFinite(p) && p > 0 ? p : fallback;
    } catch {
      return fallback;
    }
  }

  private ageMinutes(tweet: Tweet): number {
    const created = Date.parse(tweet.createdAt);
    if (!Number.isFinite(created)) return Number.POSITIVE_INFINITY;
    return (this.now().getTime() - created) / 60_000;
  }

  /** Map a free-text asset name onto an allowlisted pair. */
  private resolveSymbol(asset: string | null): string | undefined {
    if (!asset) return undefined;
    const key = asset.trim().toLowerCase().replace(/^\$/, "");
    if (this.d.config.symbols[key]) return this.d.config.symbols[key];
    // Tolerate "BTC/USDT", "BTCUSDT" and "BTC-USD" style mentions.
    const base = key.split(/[/\-\s]/)[0]?.replace(/usdt?$/, "") ?? "";
    return base ? this.d.config.symbols[base] : undefined;
  }

  private async log(
    tweet: Tweet,
    mode: "live" | "paper",
    analysis: TweetAnalysis | null,
    decision: TweetDecision
  ): Promise<TweetDecision> {
    const record: TweetLogRecord = {
      tweetId: tweet.id,
      handle: tweet.authorHandle,
      tweetCreatedAt: tweet.createdAt,
      processedAt: this.now().toISOString(),
      text: tweet.text,
      mode,
      analysis,
      decision,
    };
    this.d.tweetLog.record(record);

    // Alert on anything the human would want to know about: trades taken, and
    // real calls we chose not to take. Routine commentary stays silent.
    if (mode === "live" && decision.action === "skipped" && analysis?.actionable) {
      await this.d.notifier.notify(
        `⏭️ Tweet call NOT taken (${decision.reason})\n${tweet.url}\n"${truncate(tweet.text, 200)}"`
      );
    }
    return decision;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
