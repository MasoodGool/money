/**
 * SQLite log of every tweet the system has read, how the analyst model
 * classified it, and what the router did about it.
 *
 * This is the audit trail for "check every tweet": one row per tweet, whether
 * or not it produced a trade. The backfill report reads it, and it is the
 * evidence base for tuning the confidence/conviction gates before arming.
 */

import { DatabaseSync } from "node:sqlite";

import type { TweetAnalysis, TweetDecision, TweetLog, TweetLogRecord } from "./types.js";

export interface TweetLogRow extends TweetLogRecord {
  id: number;
}

export class SqliteTweetLog implements TweetLog {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tweets (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        tweet_id         TEXT NOT NULL,
        handle           TEXT NOT NULL,
        tweet_created_at TEXT NOT NULL,
        processed_at     TEXT NOT NULL,
        text             TEXT NOT NULL,
        mode             TEXT NOT NULL,
        analysis_json    TEXT,
        decision_json    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tweets_created ON tweets(tweet_created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tweets_unique ON tweets(tweet_id, mode);
    `);
  }

  record(r: TweetLogRecord): void {
    // Re-running a backfill over the same window must not duplicate rows;
    // the newest read of a tweet wins for that mode.
    this.db
      .prepare(
        `INSERT INTO tweets
           (tweet_id, handle, tweet_created_at, processed_at, text, mode,
            analysis_json, decision_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tweet_id, mode) DO UPDATE SET
           processed_at=excluded.processed_at,
           analysis_json=excluded.analysis_json,
           decision_json=excluded.decision_json`
      )
      .run(
        r.tweetId,
        r.handle,
        r.tweetCreatedAt,
        r.processedAt,
        r.text,
        r.mode,
        r.analysis ? JSON.stringify(r.analysis) : null,
        JSON.stringify(r.decision)
      );
  }

  all(): TweetLogRow[] {
    return this.mapRows(
      this.db.prepare("SELECT * FROM tweets ORDER BY tweet_created_at").all()
    );
  }

  byMode(mode: "live" | "paper"): TweetLogRow[] {
    return this.mapRows(
      this.db
        .prepare("SELECT * FROM tweets WHERE mode = ? ORDER BY tweet_created_at")
        .all(mode)
    );
  }

  private mapRows(rows: unknown[]): TweetLogRow[] {
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      id: Number(r["id"]),
      tweetId: String(r["tweet_id"]),
      handle: String(r["handle"]),
      tweetCreatedAt: String(r["tweet_created_at"]),
      processedAt: String(r["processed_at"]),
      text: String(r["text"]),
      mode: r["mode"] as "live" | "paper",
      analysis: r["analysis_json"]
        ? (JSON.parse(String(r["analysis_json"])) as TweetAnalysis)
        : null,
      decision: JSON.parse(String(r["decision_json"])) as TweetDecision,
    }));
  }
}
