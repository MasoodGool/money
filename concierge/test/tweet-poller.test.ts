import { describe, expect, it, vi } from "vitest";

import type { Notifier } from "../src/notifier.js";
import { InMemoryStore } from "../src/store.js";
import { TweetPoller } from "../src/tweets/poller.js";
import type { TweetRouter } from "../src/tweets/router.js";
import type { Tweet, TweetDecision } from "../src/tweets/types.js";
import { FixtureTweetSource } from "../src/tweets/x-source.js";

const NOW = new Date("2026-08-02T12:00:00Z");

function tweet(id: string, daysAgo = 0, text = "longing SOL"): Tweet {
  return {
    id,
    text,
    createdAt: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(),
    authorHandle: "TradexWhisperer",
    isRetweet: false,
    isReply: false,
    url: `https://x.com/TradexWhisperer/status/${id}`,
  };
}

function makeNotifier(): Notifier & { messages: string[] } {
  const messages: string[] = [];
  return { messages, notify: async (m: string) => void messages.push(m) };
}

/** Router stub recording (tweetId, mode) and returning canned decisions. */
function stubRouter(decide: (t: Tweet, mode: string) => TweetDecision) {
  const seen: Array<{ id: string; mode: string }> = [];
  const router = {
    process: vi.fn(async (t: Tweet, mode: "live" | "paper" = "live") => {
      seen.push({ id: t.id, mode });
      return decide(t, mode);
    }),
  };
  return { router: router as unknown as TweetRouter, seen };
}

function build(tweets: Tweet[], decide = () => ({ action: "ignored", reason: "x" }) as TweetDecision) {
  const { router, seen } = stubRouter(decide);
  const store = new InMemoryStore();
  const notifier = makeNotifier();
  const poller = new TweetPoller({
    source: new FixtureTweetSource("TradexWhisperer", tweets),
    router,
    store,
    notifier,
    pollSeconds: 60,
    log: () => undefined,
    now: () => NOW,
  });
  return { poller, seen, store, notifier };
}

describe("TweetPoller.backfill", () => {
  const month = [
    tweet("101", 25, "longing SOL"),
    tweet("102", 20, "gm"),
    tweet("103", 10, "out of BTC"),
    tweet("104", 40, "too old for the window"),
  ];

  it("reads the window in paper mode and never places an order", async () => {
    const { poller, seen } = build(month, (_t, mode) =>
      mode === "paper"
        ? { action: "skipped", reason: "paper mode — would BUY SOL/USDT" }
        : { action: "entered", symbol: "SOL/USDT", tradeId: "x", detail: "" }
    );

    const summary = await poller.backfill(30);

    // The 40-day-old tweet is outside the window.
    expect(summary.tweets).toBe(3);
    expect(seen.every((s) => s.mode === "paper")).toBe(true);
    expect(seen.map((s) => s.id)).toEqual(["101", "102", "103"]);
  });

  it("counts would-be entries and exits separately", async () => {
    const { poller } = build(month, (t) =>
      t.id === "101"
        ? { action: "skipped", reason: "paper mode — would BUY SOL/USDT" }
        : t.id === "103"
          ? { action: "skipped", reason: "paper mode — would CLOSE BTC/USDT" }
          : { action: "ignored", reason: "not a call" }
    );

    const summary = await poller.backfill(30);

    expect(summary).toMatchObject({
      tweets: 3,
      actionable: 2,
      wouldEnter: 1,
      wouldExit: 1,
      ignored: 1,
    });
  });

  it("does not advance the live cursor", async () => {
    const { poller, store } = build(month);
    await poller.backfill(30);
    expect(store.getSetting("x_since_id")).toBeUndefined();
  });
});

describe("TweetPoller — forward feed", () => {
  const feed = [tweet("201"), tweet("202"), tweet("203")];

  it("primes the cursor without treating the backlog as live signals", async () => {
    const { poller, seen, store } = build(feed);

    const primed = await poller.primeCursor();

    expect(primed).toBe("203");
    expect(store.getSetting("x_since_id")).toBe("203");
    expect(seen).toHaveLength(0);
  });

  it("keeps an existing cursor on restart", async () => {
    const { poller, store } = build(feed);
    store.setSetting("x_since_id", "201");

    expect(await poller.primeCursor()).toBe("201");
    expect(store.getSetting("x_since_id")).toBe("201");
  });

  it("processes only tweets newer than the cursor, in live mode", async () => {
    const { poller, seen, store } = build(feed);
    store.setSetting("x_since_id", "201");

    const count = await poller.pollOnce();

    expect(count).toBe(2);
    expect(seen).toEqual([
      { id: "202", mode: "live" },
      { id: "203", mode: "live" },
    ]);
    expect(store.getSetting("x_since_id")).toBe("203");
  });

  it("advances the cursor per tweet so a crash cannot replay a decision", async () => {
    const { poller, store } = build(feed, (t) => {
      if (t.id === "203") throw new Error("router exploded");
      return { action: "ignored", reason: "x" };
    });
    store.setSetting("x_since_id", "201");

    await expect(poller.pollOnce()).rejects.toThrow("router exploded");
    // 202 was decided and is not replayed; 203 is retried next tick.
    expect(store.getSetting("x_since_id")).toBe("202");
  });

  it("orders snowflake ids numerically, not lexically", async () => {
    // "9..." must sort BELOW "10..." — a lexical compare would drop the newer
    // tweet and stall the cursor.
    const { poller, seen, store } = build([tweet("999999999"), tweet("1000000000")]);
    store.setSetting("x_since_id", "999999999");

    await poller.pollOnce();

    expect(seen.map((s) => s.id)).toEqual(["1000000000"]);
    expect(store.getSetting("x_since_id")).toBe("1000000000");
  });

  it("reports nothing to do on an empty poll", async () => {
    const { poller, store } = build(feed);
    store.setSetting("x_since_id", "203");
    expect(await poller.pollOnce()).toBe(0);
  });
});

describe("TweetPoller — failure handling", () => {
  it("alerts on the first feed failure and keeps polling", async () => {
    const { router } = stubRouter(() => ({ action: "ignored", reason: "x" }));
    const notifier = makeNotifier();
    const failing = {
      handle: "TradexWhisperer",
      fetch: vi.fn(async () => {
        throw new Error("X API 429");
      }),
    };
    const poller = new TweetPoller({
      source: failing,
      router,
      store: new InMemoryStore(),
      notifier,
      pollSeconds: 60,
      log: () => undefined,
    });

    poller.start();
    await vi.waitFor(() => expect(notifier.messages).toHaveLength(1));
    poller.stop();

    expect(notifier.messages[0]).toMatch(/Tweet feed error \(1x\): X API 429/);
  });
});
