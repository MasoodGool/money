/**
 * X (Twitter) API v2 tweet source.
 *
 * Reads one account's timeline via:
 *   GET /2/users/by/username/:handle   -> numeric user id (cached)
 *   GET /2/users/:id/tweets            -> timeline, paginated
 *
 * ACCESS NOTE: user-timeline reads are NOT on the X API free tier — a paid
 * tier (Basic or above) is required for `GET /2/users/:id/tweets`. Without a
 * working token this class throws loudly rather than returning an empty page:
 * a silent empty timeline would look exactly like "the account went quiet",
 * and the bot would sit there having stopped reading signals.
 */

import type { FetchOptions, Tweet, TweetSource } from "./types.js";

const API_BASE = "https://api.x.com/2";

/** Max the API allows per page for a user timeline. */
const PAGE_SIZE = 100;

export interface XApiOptions {
  handle: string;
  bearerToken: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Request timeout in ms. */
  timeoutMs?: number;
  /** Skip retweets (they are someone else's call, not this account's). */
  excludeRetweets?: boolean;
  /** Skip replies (usually conversation, not calls). */
  excludeReplies?: boolean;
}

interface XTweetPayload {
  id: string;
  text: string;
  created_at?: string;
  referenced_tweets?: Array<{ type: string; id: string }>;
}

interface XTimelineResponse {
  data?: XTweetPayload[];
  meta?: { next_token?: string; result_count?: number };
  errors?: Array<{ title?: string; detail?: string }>;
}

/**
 * Compare two snowflake ids numerically. They are decimal strings that exceed
 * Number.MAX_SAFE_INTEGER, so compare by length first, then lexically — plain
 * localeCompare would order "9..." above "10..." and lose tweets.
 */
export function compareTweetIds(a: string, b: string): number {
  return a.length !== b.length ? a.length - b.length : a.localeCompare(b);
}

export class XApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string
  ) {
    super(message);
    this.name = "XApiError";
  }
}

export class XApiTweetSource implements TweetSource {
  readonly handle: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly excludeRetweets: boolean;
  private readonly excludeReplies: boolean;
  private userId: string | undefined;

  constructor(opts: XApiOptions) {
    this.handle = opts.handle.replace(/^@/, "");
    this.token = opts.bearerToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.excludeRetweets = opts.excludeRetweets ?? true;
    this.excludeReplies = opts.excludeReplies ?? false;
  }

  private async call(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: controller.signal,
      });
      const body = await res.text();
      if (!res.ok) {
        // 401 = bad token, 403 = tier does not allow this endpoint,
        // 429 = rate limited. All are loud failures, never empty results.
        throw new XApiError(
          `X API ${res.status} for ${url.replace(/\?.*$/, "")}: ${body.slice(0, 300)}`,
          res.status,
          body
        );
      }
      return JSON.parse(body) as unknown;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Resolve and cache the numeric user id for the handle. */
  async resolveUserId(): Promise<string> {
    if (this.userId) return this.userId;
    const payload = (await this.call(
      `${API_BASE}/users/by/username/${encodeURIComponent(this.handle)}`
    )) as { data?: { id?: string }; errors?: Array<{ detail?: string }> };
    const id = payload.data?.id;
    if (!id) {
      throw new XApiError(
        `X API returned no user id for @${this.handle}: ${JSON.stringify(payload.errors ?? payload)}`,
        200,
        JSON.stringify(payload)
      );
    }
    this.userId = id;
    return id;
  }

  async fetch(opts: FetchOptions = {}): Promise<Tweet[]> {
    const userId = await this.resolveUserId();
    const limit = opts.limit ?? 1000;
    const collected: Tweet[] = [];
    let nextToken: string | undefined;

    do {
      const params = new URLSearchParams({
        max_results: String(Math.min(PAGE_SIZE, Math.max(5, limit - collected.length))),
        "tweet.fields": "created_at,referenced_tweets",
      });
      const exclude: string[] = [];
      if (this.excludeRetweets) exclude.push("retweets");
      if (this.excludeReplies) exclude.push("replies");
      if (exclude.length > 0) params.set("exclude", exclude.join(","));
      // since_id wins over start_time when both are set — it is the exact
      // cursor, whereas start_time is only a window.
      if (opts.sinceId) params.set("since_id", opts.sinceId);
      else if (opts.startTime) params.set("start_time", opts.startTime);
      if (nextToken) params.set("pagination_token", nextToken);

      const page = (await this.call(
        `${API_BASE}/users/${userId}/tweets?${params.toString()}`
      )) as XTimelineResponse;

      for (const t of page.data ?? []) collected.push(this.toTweet(t));
      nextToken = page.meta?.next_token;
    } while (nextToken && collected.length < limit);

    // The API returns newest-first; downstream wants chronological order.
    return collected.sort((a, b) => compareTweetIds(a.id, b.id));
  }

  private toTweet(t: XTweetPayload): Tweet {
    const refs = t.referenced_tweets ?? [];
    return {
      id: t.id,
      text: t.text,
      // created_at is requested explicitly; fall back to epoch so a missing
      // field fails the freshness gate rather than looking brand new.
      createdAt: t.created_at ?? new Date(0).toISOString(),
      authorHandle: this.handle,
      isRetweet: refs.some((r) => r.type === "retweeted"),
      isReply: refs.some((r) => r.type === "replied_to"),
      url: `https://x.com/${this.handle}/status/${t.id}`,
    };
  }
}

/**
 * Replay source for tests and dry runs: serves a fixed list of tweets and
 * honours sinceId / startTime the same way the live source does.
 */
export class FixtureTweetSource implements TweetSource {
  readonly handle: string;

  constructor(
    handle: string,
    private readonly tweets: Tweet[]
  ) {
    this.handle = handle.replace(/^@/, "");
  }

  async fetch(opts: FetchOptions = {}): Promise<Tweet[]> {
    const sinceId = opts.sinceId;
    let out = [...this.tweets].sort((a, b) => compareTweetIds(a.id, b.id));
    if (sinceId) out = out.filter((t) => compareTweetIds(t.id, sinceId) > 0);
    if (opts.startTime) out = out.filter((t) => t.createdAt >= opts.startTime!);
    if (opts.limit !== undefined) out = out.slice(0, opts.limit);
    return out;
  }
}
