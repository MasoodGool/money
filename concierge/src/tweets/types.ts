/**
 * Tweet-driven signal source: shared types.
 *
 * The pipeline is: TweetSource -> TweetAnalyzer -> TweetRouter -> Executor.
 * Every stage is an interface so the whole path is unit-testable without an
 * X API key, an Anthropic key, or an exchange connection.
 */

/** A single tweet, normalised from the X API v2 payload. */
export interface Tweet {
  id: string;
  /** Full tweet text (X API `text` field). */
  text: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** Handle without the leading @, e.g. "TradexWhisperer". */
  authorHandle: string;
  /** True when this tweet is a retweet of someone else's post. */
  isRetweet: boolean;
  /** True when this tweet is a reply. */
  isReply: boolean;
  /** Convenience link for alerts. */
  url: string;
}

export interface FetchOptions {
  /** Return only tweets newer than this id (X API `since_id`). */
  sinceId?: string;
  /** Return only tweets at/after this ISO time (X API `start_time`). */
  startTime?: string;
  /** Hard cap on tweets returned across all pages. */
  limit?: number;
}

/**
 * A source of tweets for one account. Implementations must return tweets in
 * OLDEST-FIRST order so downstream processing is chronological.
 */
export interface TweetSource {
  /** The handle this source reads, without the leading @. */
  readonly handle: string;
  fetch(opts?: FetchOptions): Promise<Tweet[]>;
}

/** What the analyst model extracted from one tweet. */
export interface TweetAnalysis {
  /** True only when the tweet is a directional call on a specific asset. */
  actionable: boolean;
  /**
   * `buy`   — opening/adding a long
   * `sell`  — closing a long, or a bearish/short call (we are spot long-only,
   *           so a bearish call can only ever close an existing position)
   * `close` — explicit "taking profit"/"out" on a prior call
   * `none`  — commentary, education, memes, engagement bait
   */
  action: "buy" | "sell" | "close" | "none";
  /** Ticker as written in the tweet ("BTC", "bitcoin"), or null. */
  asset: string | null;
  conviction: "low" | "medium" | "high";
  /** 0..1 — the model's confidence in its own reading of the tweet. */
  confidence: number;
  timeHorizon: "intraday" | "swing" | "long" | "unknown";
  /** True for "this could run" musings, price predictions with no call, etc. */
  speculative: boolean;
  /** One sentence explaining the classification. Shown in alerts. */
  rationale: string;
}

export interface TweetAnalyzer {
  analyze(tweet: Tweet): Promise<TweetAnalysis>;
}

/** Current mid/last price for a symbol, used to size a tweet-driven entry. */
export interface PriceSource {
  getPrice(symbol: string): Promise<number>;
}

/** What the router decided to do with a tweet. */
export type TweetDecision =
  | { action: "entered"; symbol: string; tradeId: string; detail: string }
  | { action: "exited"; symbol: string; tradeId: string; detail: string }
  | { action: "ignored"; reason: string }
  | { action: "skipped"; reason: string };

/** A processed tweet: what it said, what we read into it, what we did. */
export interface TweetLogRecord {
  tweetId: string;
  handle: string;
  tweetCreatedAt: string;
  processedAt: string;
  text: string;
  /** "live" for the forward feed, "paper" for the historical backfill. */
  mode: "live" | "paper";
  analysis: TweetAnalysis | null;
  decision: TweetDecision;
}

/** Durable record of every tweet the system has looked at. */
export interface TweetLog {
  record(r: TweetLogRecord): void;
}

export class NoopTweetLog implements TweetLog {
  record(): void {}
}
