/**
 * TweetPoller: drives the tweet feed.
 *
 * Two modes:
 *   - `backfill(days)` — walks a historical window in PAPER mode. Old calls
 *     cannot be traded (see docs/tweet-signals.md), so this measures what the
 *     account said and what the pipeline would have done, without ordering.
 *   - `start()` — polls forward on an interval, processing only tweets newer
 *     than the persisted cursor, in LIVE mode.
 *
 * The cursor (`x_since_id`) is persisted after every batch so a restart
 * resumes where it left off instead of re-reading — or worse, skipping — the
 * window it was down for.
 */

import type { Notifier } from "../notifier.js";
import type { StateStore } from "../store.js";
import { compareTweetIds } from "./x-source.js";
import type { TweetRouter } from "./router.js";
import type { Tweet, TweetDecision, TweetSource } from "./types.js";

const CURSOR_KEY = "x_since_id";

export interface TweetPollerDeps {
  source: TweetSource;
  router: TweetRouter;
  store: StateStore;
  notifier: Notifier;
  /** Seconds between polls. */
  pollSeconds: number;
  log?: (msg: string) => void;
  now?: () => Date;
}

export interface BackfillSummary {
  tweets: number;
  actionable: number;
  wouldEnter: number;
  wouldExit: number;
  ignored: number;
  skipped: number;
  newestId: string | undefined;
}

export class TweetPoller {
  private readonly d: TweetPollerDeps;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | undefined;
  private polling = false;
  /** Consecutive failures — used to widen the gap after repeated errors. */
  private failures = 0;

  constructor(deps: TweetPollerDeps) {
    this.d = deps;
    this.now = deps.now ?? (() => new Date());
  }

  private log(msg: string): void {
    (this.d.log ?? console.log)(msg);
  }

  getCursor(): string | undefined {
    return this.d.store.getSetting(CURSOR_KEY);
  }

  /**
   * Walk the last `days` of the timeline in paper mode.
   *
   * Does NOT advance the live cursor: a backfill is an analysis pass, and
   * must never suppress the forward feed or place an order.
   */
  async backfill(days: number): Promise<BackfillSummary> {
    const startTime = new Date(this.now().getTime() - days * 86_400_000).toISOString();
    const tweets = await this.d.source.fetch({ startTime });
    this.log(`backfill: ${tweets.length} tweets from @${this.d.source.handle} since ${startTime}`);

    const summary: BackfillSummary = {
      tweets: tweets.length,
      actionable: 0,
      wouldEnter: 0,
      wouldExit: 0,
      ignored: 0,
      skipped: 0,
      newestId: tweets.at(-1)?.id,
    };

    for (const tweet of tweets) {
      const decision = await this.d.router.process(tweet, "paper");
      if (decision.action === "ignored") summary.ignored++;
      else summary.skipped++;
      // In paper mode a would-be trade surfaces as a skip carrying the intent.
      if (decision.action === "skipped" && decision.reason.includes("would BUY")) {
        summary.actionable++;
        summary.wouldEnter++;
      } else if (decision.action === "skipped" && decision.reason.includes("would CLOSE")) {
        summary.actionable++;
        summary.wouldExit++;
      }
    }
    return summary;
  }

  /**
   * Point the cursor at the newest existing tweet WITHOUT processing the
   * backlog. Without this, a fresh deploy would treat every tweet in the
   * account's recent history as a live signal.
   */
  async primeCursor(): Promise<string | undefined> {
    const existing = this.getCursor();
    if (existing) return existing;
    const latest = await this.d.source.fetch({ limit: 5 });
    const newest = latest.at(-1)?.id;
    if (newest) {
      this.d.store.setSetting(CURSOR_KEY, newest);
      this.log(`tweet cursor primed at ${newest} (backlog not treated as live signals)`);
    }
    return newest;
  }

  /** Fetch and process everything newer than the cursor. Returns tweet count. */
  async pollOnce(): Promise<number> {
    const sinceId = this.getCursor();
    const tweets = await this.d.source.fetch(sinceId ? { sinceId } : { limit: 5 });
    if (tweets.length === 0) return 0;

    const decisions: Array<{ tweet: Tweet; decision: TweetDecision }> = [];
    for (const tweet of tweets) {
      decisions.push({ tweet, decision: await this.d.router.process(tweet, "live") });
      // Advance per tweet: if the process dies mid-batch, the tweets already
      // decided on are not replayed.
      const cursor = this.getCursor();
      if (!cursor || compareTweetIds(tweet.id, cursor) > 0) {
        this.d.store.setSetting(CURSOR_KEY, tweet.id);
      }
    }

    const traded = decisions.filter(
      (d) => d.decision.action === "entered" || d.decision.action === "exited"
    ).length;
    this.log(`polled ${tweets.length} new tweet(s) from @${this.d.source.handle}; ${traded} traded`);
    return tweets.length;
  }

  /** Begin polling. Runs an immediate pass, then every `pollSeconds`. */
  start(): void {
    if (this.timer) return;
    const tick = async (): Promise<void> => {
      if (this.polling) return; // never overlap a slow poll with the next tick
      this.polling = true;
      try {
        await this.pollOnce();
        this.failures = 0;
      } catch (err) {
        this.failures++;
        const message = (err as Error).message;
        this.log(`tweet poll failed (${this.failures}): ${message}`);
        // Alert on the first failure and then sparingly — a broken feed is
        // silent by nature and must not go unnoticed, but it must not spam
        // either.
        if (this.failures === 1 || this.failures % 20 === 0) {
          await this.d.notifier
            .notify(`⚠️ Tweet feed error (${this.failures}x): ${message}`)
            .catch(() => undefined);
        }
      } finally {
        this.polling = false;
      }
    };
    void tick();
    this.timer = setInterval(() => void tick(), this.d.pollSeconds * 1000);
    // Don't hold the event loop open on shutdown.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
