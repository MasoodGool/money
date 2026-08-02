/**
 * Tweet analyst: turns free-text tweets into a structured trading read.
 *
 * Two stages, cheapest first:
 *   1. `prefilter` — deterministic, no API call. Drops retweets, empty text,
 *      and anything that never names a tradable asset. Most of a timeline is
 *      commentary; there is no reason to pay for a model call on it.
 *   2. `ClaudeTweetAnalyzer` — Claude with a strict JSON schema, so the
 *      output is always a valid TweetAnalysis (no prose, no parsing guesswork).
 *
 * The model is a CLASSIFIER, not a trader. It reports what the tweet says; it
 * never decides whether to trade. Sizing, allowlisting, freshness and every
 * risk gate live in the router and the executor.
 */

import Anthropic from "@anthropic-ai/sdk";

import type { Tweet, TweetAnalysis, TweetAnalyzer } from "./types.js";

/** The classification returned when a tweet obviously carries no signal. */
export function inertAnalysis(rationale: string): TweetAnalysis {
  return {
    actionable: false,
    action: "none",
    asset: null,
    conviction: "low",
    confidence: 1,
    timeHorizon: "unknown",
    speculative: false,
    rationale,
  };
}

/**
 * Cheap deterministic screen. Returns an analysis to short-circuit with, or
 * undefined when the tweet is worth a model call.
 *
 * `aliases` is every string that could name a tradable asset (tickers plus
 * common long names). A tweet that mentions none of them cannot produce a
 * trade we are allowed to place, so it never reaches the model.
 */
export function prefilter(tweet: Tweet, aliases: string[]): TweetAnalysis | undefined {
  if (tweet.isRetweet) return inertAnalysis("retweet — not this account's own call");
  const text = tweet.text.trim();
  if (text.length === 0) return inertAnalysis("empty tweet text");

  const haystack = text.toLowerCase();
  const mentions = aliases.some((alias) => {
    const a = alias.toLowerCase();
    // Word-ish boundary so "SOL" does not match "solution" and "eth" does not
    // match "ethics", while still catching "$SOL", "SOL/USDT" and "SOL."
    return new RegExp(`(^|[^a-z0-9])\\$?${escapeRegExp(a)}([^a-z0-9]|$)`).test(haystack);
  });
  if (!mentions) return inertAnalysis("no tradable asset mentioned");

  return undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    actionable: {
      type: "boolean",
      description:
        "True only if the tweet is a clear directional call to open or close a position in a specific asset.",
    },
    action: {
      type: "string",
      enum: ["buy", "sell", "close", "none"],
      description:
        "buy = open/add a long. sell = bearish call or exit. close = explicitly closing a prior call. none = no call.",
    },
    asset: {
      type: ["string", "null"],
      description: "The asset ticker or name exactly as written in the tweet, else null.",
    },
    conviction: { type: "string", enum: ["low", "medium", "high"] },
    confidence: {
      type: "number",
      description: "0..1 confidence that this classification is correct.",
    },
    timeHorizon: { type: "string", enum: ["intraday", "swing", "long", "unknown"] },
    speculative: {
      type: "boolean",
      description:
        "True for musings, price predictions, or 'this could run' talk with no actual call to act.",
    },
    rationale: { type: "string", description: "One sentence justifying the classification." },
  },
  required: [
    "actionable",
    "action",
    "asset",
    "conviction",
    "confidence",
    "timeHorizon",
    "speculative",
    "rationale",
  ],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You classify tweets from a crypto trading account into structured trading signals.

You are a classifier, not a trader. Report only what the tweet actually says. Never infer a
call that is not there, and never let your own market view influence the reading.

Rules:
- \`actionable\` is true ONLY for an unambiguous call to act on a specific named asset
  ("longing SOL here", "buying BTC at 60k", "out of ETH"). Everything else is false.
- Commentary, chart talk, price predictions, engagement bait, subscription promos,
  general market takes and "watching X closely" are NOT actionable. Set speculative=true
  when the tweet leans on a prediction or possibility rather than an executed decision.
- A tweet naming several assets with no single clear call is not actionable.
- \`asset\` is the ticker/name as written; leave it null when no specific asset is named.
- \`confidence\` reflects how sure you are of your READING of the tweet, not how likely the
  trade is to profit. Sarcasm, ambiguity, slang or hedging should lower it.
- When a tweet is ambiguous, prefer actionable=false. A missed signal costs nothing; a
  misread one places a real order with real money.`;

export interface ClaudeAnalyzerOptions {
  apiKey: string;
  /** Defaults to claude-opus-5. */
  model?: string;
  /** Asset aliases used by the prefilter. */
  aliases: string[];
  /** Injectable for tests. */
  client?: Pick<Anthropic, "messages">;
  maxTokens?: number;
}

export class ClaudeTweetAnalyzer implements TweetAnalyzer {
  private readonly client: Pick<Anthropic, "messages">;
  private readonly model: string;
  private readonly aliases: string[];
  private readonly maxTokens: number;

  constructor(opts: ClaudeAnalyzerOptions) {
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model ?? "claude-opus-5";
    this.aliases = opts.aliases;
    // Generous: max_tokens caps thinking + response together on Opus 5, and a
    // truncated response would be unparseable JSON.
    this.maxTokens = opts.maxTokens ?? 8000;
  }

  async analyze(tweet: Tweet): Promise<TweetAnalysis> {
    const short = prefilter(tweet, this.aliases);
    if (short) return short;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: SYSTEM_PROMPT,
      output_config: { format: { type: "json_schema", schema: ANALYSIS_SCHEMA } },
      messages: [
        {
          role: "user",
          content:
            `Tweet by @${tweet.authorHandle} posted ${tweet.createdAt}:\n\n` +
            `"""\n${tweet.text}\n"""\n\n` +
            `Classify it.`,
        },
      ],
    });

    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") {
      throw new Error(
        `analyst returned no text block (stop_reason=${response.stop_reason ?? "unknown"})`
      );
    }
    return normalizeAnalysis(JSON.parse(text.text) as Record<string, unknown>);
  }
}

/**
 * Coerce a model payload into a TweetAnalysis. The JSON schema already
 * guarantees the shape; this clamps the numeric field and defends the
 * invariants the router relies on, so a malformed read can never widen into
 * an unintended trade.
 */
export function normalizeAnalysis(raw: Record<string, unknown>): TweetAnalysis {
  const action = raw["action"];
  const analysis: TweetAnalysis = {
    actionable: raw["actionable"] === true,
    action:
      action === "buy" || action === "sell" || action === "close" ? action : "none",
    asset: typeof raw["asset"] === "string" && raw["asset"].trim() !== "" ? raw["asset"] : null,
    conviction:
      raw["conviction"] === "high" || raw["conviction"] === "medium"
        ? raw["conviction"]
        : "low",
    confidence: clamp01(Number(raw["confidence"])),
    timeHorizon:
      raw["timeHorizon"] === "intraday" ||
      raw["timeHorizon"] === "swing" ||
      raw["timeHorizon"] === "long"
        ? raw["timeHorizon"]
        : "unknown",
    speculative: raw["speculative"] === true,
    rationale: typeof raw["rationale"] === "string" ? raw["rationale"] : "",
  };
  // "actionable with no action" and "action with no asset" are incoherent
  // reads; treat both as no signal rather than guessing what was meant.
  if (analysis.action === "none" || analysis.asset === null) analysis.actionable = false;
  return analysis;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
