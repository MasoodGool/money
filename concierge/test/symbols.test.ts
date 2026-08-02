import { describe, expect, it } from "vitest";

import { prefilter } from "../src/tweets/analyzer.js";
import {
  aliasesOf,
  buildEquitySymbolMap,
  buildSymbolMap,
  DEFAULT_EQUITY_ASSETS,
} from "../src/tweets/symbols.js";
import type { Tweet } from "../src/tweets/types.js";

describe("buildSymbolMap (crypto)", () => {
  it("maps tickers and long names onto a quote pair", () => {
    const map = buildSymbolMap(["BTC", "SOL"]);

    expect(map["btc"]).toBe("BTC/USDT");
    expect(map["bitcoin"]).toBe("BTC/USDT");
    expect(map["solana"]).toBe("SOL/USDT");
    expect(map["pepe"]).toBeUndefined();
  });
});

describe("buildEquitySymbolMap", () => {
  it("maps tickers and company names onto bare tickers", () => {
    const map = buildEquitySymbolMap(["MU", "PLTR", "RKLB"]);

    expect(map["mu"]).toBe("MU");
    expect(map["micron"]).toBe("MU");
    expect(map["palantir"]).toBe("PLTR");
    expect(map["rocket lab"]).toBe("RKLB");
  });

  it("accepts tickers written with a $ prefix or odd casing", () => {
    const map = buildEquitySymbolMap([" $nvda ", "tsm"]);

    expect(map["nvda"]).toBe("NVDA");
    expect(map["tsm"]).toBe("TSM");
  });

  it("includes only the tickers asked for", () => {
    const map = buildEquitySymbolMap(["MU"]);

    expect(map["nvda"]).toBeUndefined();
    expect(map["gme"]).toBeUndefined();
  });

  it("covers the assets the followed account actually writes about", () => {
    const map = buildEquitySymbolMap(DEFAULT_EQUITY_ASSETS);

    for (const alias of ["mu", "pltr", "rklb", "sndk", "tsm", "nvda"]) {
      expect(map[alias], alias).toBeDefined();
    }
  });
});

describe("prefilter with equity aliases", () => {
  const aliases = aliasesOf(buildEquitySymbolMap(DEFAULT_EQUITY_ASSETS));

  function tweet(text: string): Tweet {
    return {
      id: "1",
      text,
      createdAt: new Date().toISOString(),
      authorHandle: "TradexWhisperer",
      isRetweet: false,
      isReply: false,
      url: "https://x.com/TradexWhisperer/status/1",
    };
  }

  it("passes real ticker mentions to the analyst", () => {
    expect(prefilter(tweet("Bargain thesis: $MU at $62"), aliases)).toBeUndefined();
    expect(prefilter(tweet("Micron memory demand is inflecting"), aliases)).toBeUndefined();
    expect(prefilter(tweet("adding $PLTR here"), aliases)).toBeUndefined();
  });

  it("drops macro commentary that names nothing tradable", () => {
    expect(prefilter(tweet("Semiconductor exports data out tomorrow"), aliases)?.action).toBe(
      "none"
    );
  });

  it("does not fire on a ticker embedded in a longer word", () => {
    // "MU" inside "MUCH", "TSM" inside a URL slug, etc.
    expect(prefilter(tweet("MUCH stronger than expected"), aliases)?.action).toBe("none");
  });
});
