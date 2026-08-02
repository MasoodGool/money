import { describe, expect, it, vi } from "vitest";

import { compareTweetIds, XApiError, XApiTweetSource } from "../src/tweets/x-source.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Fake fetch that answers the user lookup, then serves timeline pages. */
function fakeFetch(pages: unknown[], userId = "u1") {
  const calls: string[] = [];
  let page = 0;
  const impl = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/users/by/username/")) return jsonResponse({ data: { id: userId } });
    return jsonResponse(pages[page++] ?? { data: [] });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const TWEETS = [
  { id: "1000000000000000002", text: "second", created_at: "2026-08-02T10:00:00.000Z" },
  { id: "999999999999999999", text: "first", created_at: "2026-08-01T10:00:00.000Z" },
];

describe("compareTweetIds", () => {
  it("orders snowflake ids numerically", () => {
    expect(compareTweetIds("999", "1000")).toBeLessThan(0);
    expect(compareTweetIds("1001", "1000")).toBeGreaterThan(0);
    expect(compareTweetIds("1000", "1000")).toBe(0);
  });
});

describe("XApiTweetSource", () => {
  it("resolves the handle once and returns tweets oldest-first", async () => {
    const { impl, calls } = fakeFetch([{ data: TWEETS }]);
    const source = new XApiTweetSource({
      handle: "@TradexWhisperer",
      bearerToken: "t",
      fetchImpl: impl,
    });

    const first = await source.fetch();
    const second = await source.fetch();

    expect(first.map((t) => t.text)).toEqual(["first", "second"]);
    expect(second).toEqual([]); // second page of the fake is empty
    expect(calls.filter((c) => c.includes("/users/by/username/"))).toHaveLength(1);
    expect(source.handle).toBe("TradexWhisperer");
  });

  it("marks retweets and replies from referenced_tweets", async () => {
    const { impl } = fakeFetch([
      {
        data: [
          {
            id: "1",
            text: "rt",
            created_at: "2026-08-01T10:00:00.000Z",
            referenced_tweets: [{ type: "retweeted", id: "9" }],
          },
          {
            id: "2",
            text: "reply",
            created_at: "2026-08-01T11:00:00.000Z",
            referenced_tweets: [{ type: "replied_to", id: "9" }],
          },
        ],
      },
    ]);
    const source = new XApiTweetSource({ handle: "h", bearerToken: "t", fetchImpl: impl });

    const [rt, reply] = await source.fetch();

    expect(rt).toMatchObject({ isRetweet: true, isReply: false });
    expect(reply).toMatchObject({ isRetweet: false, isReply: true });
    expect(rt!.url).toBe("https://x.com/h/status/1");
  });

  it("passes since_id through and prefers it over start_time", async () => {
    const { impl, calls } = fakeFetch([{ data: [] }]);
    const source = new XApiTweetSource({ handle: "h", bearerToken: "t", fetchImpl: impl });

    await source.fetch({ sinceId: "123", startTime: "2026-07-01T00:00:00Z" });

    const timeline = calls.find((c) => c.includes("/tweets?"))!;
    expect(timeline).toContain("since_id=123");
    expect(timeline).not.toContain("start_time");
    expect(timeline).toContain("exclude=retweets");
  });

  it("follows pagination until the token runs out", async () => {
    const { impl } = fakeFetch([
      { data: [{ id: "3", text: "c", created_at: "2026-08-03T00:00:00Z" }], meta: { next_token: "n1" } },
      { data: [{ id: "1", text: "a", created_at: "2026-08-01T00:00:00Z" }] },
    ]);
    const source = new XApiTweetSource({ handle: "h", bearerToken: "t", fetchImpl: impl });

    const out = await source.fetch();

    expect(out.map((t) => t.id)).toEqual(["1", "3"]);
  });

  it("throws loudly on an API error instead of returning an empty timeline", async () => {
    const impl = vi.fn(async () =>
      jsonResponse({ title: "Unauthorized" }, 403)
    ) as unknown as typeof fetch;
    const source = new XApiTweetSource({ handle: "h", bearerToken: "bad", fetchImpl: impl });

    await expect(source.fetch()).rejects.toThrow(XApiError);
    await expect(source.fetch()).rejects.toThrow(/X API 403/);
  });

  it("throws when the handle does not resolve", async () => {
    const impl = vi.fn(async () =>
      jsonResponse({ errors: [{ detail: "Could not find user" }] })
    ) as unknown as typeof fetch;
    const source = new XApiTweetSource({ handle: "nope", bearerToken: "t", fetchImpl: impl });

    await expect(source.fetch()).rejects.toThrow(/no user id for @nope/);
  });

  it("dates a tweet with no created_at to the epoch so it fails the freshness gate", async () => {
    const { impl } = fakeFetch([{ data: [{ id: "1", text: "x" }] }]);
    const source = new XApiTweetSource({ handle: "h", bearerToken: "t", fetchImpl: impl });

    const [t] = await source.fetch();

    expect(t!.createdAt).toBe(new Date(0).toISOString());
  });
});
