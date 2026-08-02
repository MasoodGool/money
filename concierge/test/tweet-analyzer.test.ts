import { describe, expect, it, vi } from "vitest";

import {
  ClaudeTweetAnalyzer,
  normalizeAnalysis,
  prefilter,
} from "../src/tweets/analyzer.js";
import { aliasesOf, buildSymbolMap } from "../src/tweets/symbols.js";
import type { Tweet } from "../src/tweets/types.js";

const ALIASES = aliasesOf(buildSymbolMap(["BTC", "ETH", "SOL"]));

function tweet(text: string, over: Partial<Tweet> = {}): Tweet {
  return {
    id: "1",
    text,
    createdAt: new Date().toISOString(),
    authorHandle: "TradexWhisperer",
    isRetweet: false,
    isReply: false,
    url: "https://x.com/TradexWhisperer/status/1",
    ...over,
  };
}

describe("prefilter", () => {
  it("drops retweets without a model call", () => {
    const out = prefilter(tweet("longing BTC here", { isRetweet: true }), ALIASES);
    expect(out?.actionable).toBe(false);
    expect(out?.rationale).toMatch(/retweet/);
  });

  it("drops tweets that name no tradable asset", () => {
    expect(prefilter(tweet("gm, markets look spicy today"), ALIASES)?.action).toBe("none");
  });

  it("passes tweets naming an allowlisted asset through to the model", () => {
    expect(prefilter(tweet("longing $SOL here"), ALIASES)).toBeUndefined();
    expect(prefilter(tweet("Bitcoin breaking out"), ALIASES)).toBeUndefined();
    expect(prefilter(tweet("BTC/USDT looks ready"), ALIASES)).toBeUndefined();
  });

  it("does not match tickers inside unrelated words", () => {
    // "sol" in "solution", "eth" in "ethics" — a substring match here would
    // send noise to the model and, worse, invite a bogus asset read.
    expect(prefilter(tweet("the solution is patience"), ALIASES)?.action).toBe("none");
    expect(prefilter(tweet("trading ethics matter"), ALIASES)?.action).toBe("none");
  });

  it("drops empty text", () => {
    expect(prefilter(tweet("   "), ALIASES)?.rationale).toMatch(/empty/);
  });
});

describe("normalizeAnalysis", () => {
  it("clamps confidence into 0..1 and defaults junk to safe values", () => {
    const a = normalizeAnalysis({
      actionable: true,
      action: "buy",
      asset: "BTC",
      conviction: "nonsense",
      confidence: 7,
      timeHorizon: "eventually",
      speculative: false,
      rationale: "x",
    });
    expect(a.confidence).toBe(1);
    expect(a.conviction).toBe("low");
    expect(a.timeHorizon).toBe("unknown");
  });

  it("treats a non-finite confidence as zero", () => {
    expect(normalizeAnalysis({ confidence: "abc" }).confidence).toBe(0);
  });

  it("refuses to call a tweet actionable when the read is incoherent", () => {
    // actionable with no asset, or with no action, cannot become an order.
    expect(
      normalizeAnalysis({ actionable: true, action: "buy", asset: null }).actionable
    ).toBe(false);
    expect(
      normalizeAnalysis({ actionable: true, action: "none", asset: "BTC" }).actionable
    ).toBe(false);
  });
});

describe("ClaudeTweetAnalyzer", () => {
  function fakeClient(payload: unknown) {
    const create = vi.fn(async () => ({
      content: [{ type: "text", text: JSON.stringify(payload) }],
      stop_reason: "end_turn",
    }));
    return { client: { messages: { create } } as never, create };
  }

  it("requests a strict JSON schema and returns the parsed analysis", async () => {
    const { client, create } = fakeClient({
      actionable: true,
      action: "buy",
      asset: "SOL",
      conviction: "high",
      confidence: 0.9,
      timeHorizon: "swing",
      speculative: false,
      rationale: "explicit long call",
    });
    const analyzer = new ClaudeTweetAnalyzer({
      apiKey: "k",
      aliases: ALIASES,
      client,
    });

    const out = await analyzer.analyze(tweet("longing SOL here, stop below 140"));

    expect(out).toMatchObject({ actionable: true, action: "buy", asset: "SOL" });
    const params = create.mock.calls[0]![0] as Record<string, never>;
    expect(params["model"]).toBe("claude-opus-5");
    expect(params["output_config"]).toMatchObject({
      format: { type: "json_schema" },
    });
  });

  it("short-circuits before spending a model call on noise", async () => {
    const { client, create } = fakeClient({});
    const analyzer = new ClaudeTweetAnalyzer({ apiKey: "k", aliases: ALIASES, client });

    const out = await analyzer.analyze(tweet("subscribe to my premium group"));

    expect(create).not.toHaveBeenCalled();
    expect(out.actionable).toBe(false);
  });

  it("throws when the model returns no text block", async () => {
    const create = vi.fn(async () => ({ content: [], stop_reason: "refusal" }));
    const analyzer = new ClaudeTweetAnalyzer({
      apiKey: "k",
      aliases: ALIASES,
      client: { messages: { create } } as never,
    });
    await expect(analyzer.analyze(tweet("buying BTC"))).rejects.toThrow(/no text block/);
  });
});
