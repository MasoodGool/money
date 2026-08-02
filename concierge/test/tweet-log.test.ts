import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteTweetLog } from "../src/tweets/tweet-log.js";
import type { TweetLogRecord } from "../src/tweets/types.js";

let dir: string;
let log: SqliteTweetLog;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tweetlog-"));
  log = new SqliteTweetLog(join(dir, "tweets.sqlite"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function record(over: Partial<TweetLogRecord> = {}): TweetLogRecord {
  return {
    tweetId: "1",
    handle: "TradexWhisperer",
    tweetCreatedAt: "2026-08-01T10:00:00.000Z",
    processedAt: "2026-08-01T10:00:05.000Z",
    text: "longing SOL",
    mode: "paper",
    analysis: {
      actionable: true,
      action: "buy",
      asset: "SOL",
      conviction: "high",
      confidence: 0.9,
      timeHorizon: "swing",
      speculative: false,
      rationale: "explicit long call",
    },
    decision: { action: "skipped", reason: "paper mode — would BUY SOL/USDT" },
    ...over,
  };
}

describe("SqliteTweetLog", () => {
  it("round-trips a record with its analysis and decision", () => {
    log.record(record());

    const [row] = log.all();

    expect(row).toMatchObject({ tweetId: "1", mode: "paper", text: "longing SOL" });
    expect(row!.analysis?.asset).toBe("SOL");
    expect(row!.decision).toEqual({
      action: "skipped",
      reason: "paper mode — would BUY SOL/USDT",
    });
  });

  it("re-running a backfill updates rather than duplicates", () => {
    log.record(record());
    log.record(record({ processedAt: "2026-08-02T09:00:00.000Z", analysis: null }));

    const rows = log.all();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.processedAt).toBe("2026-08-02T09:00:00.000Z");
    expect(rows[0]!.analysis).toBeNull();
  });

  it("keeps the paper and live reads of the same tweet apart", () => {
    log.record(record({ mode: "paper" }));
    log.record(record({ mode: "live" }));

    expect(log.all()).toHaveLength(2);
    expect(log.byMode("live")).toHaveLength(1);
    expect(log.byMode("paper")[0]!.mode).toBe("paper");
  });

  it("returns rows oldest-first", () => {
    log.record(record({ tweetId: "2", tweetCreatedAt: "2026-08-02T10:00:00.000Z" }));
    log.record(record({ tweetId: "1", tweetCreatedAt: "2026-08-01T10:00:00.000Z" }));

    expect(log.all().map((r) => r.tweetId)).toEqual(["1", "2"]);
  });
});
