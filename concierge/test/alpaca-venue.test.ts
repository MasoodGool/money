import { describe, expect, it, vi } from "vitest";

import { AlpacaApiError, AlpacaVenue } from "../src/alpaca-venue.js";

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

/** Fake fetch driven by a url->response map, recording every request. */
function fakeFetch(handler: (call: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    };
    calls.push(call);
    const { status = 200, body } = handler(call);
    return new Response(JSON.stringify(body), { status });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function venue(handler: (call: Call) => { status?: number; body: unknown }) {
  const { impl, calls } = fakeFetch(handler);
  return {
    calls,
    v: new AlpacaVenue({
      apiKey: "k",
      apiSecret: "s",
      paper: true,
      fetchImpl: impl,
      fillTimeoutMs: 20,
      fillPollMs: 1,
      sleepImpl: async () => undefined,
    }),
  };
}

describe("AlpacaVenue — market data", () => {
  it("prices a symbol from the latest trade", async () => {
    const { v, calls } = venue(() => ({ body: { trade: { p: 61.42 } } }));

    expect(await v.getPrice("MU")).toBe(61.42);
    expect(calls[0]!.url).toBe("https://data.alpaca.markets/v2/stocks/MU/trades/latest");
  });

  it("refuses a missing or nonsensical price rather than returning zero", async () => {
    const noTrade = venue(() => ({ body: {} }));
    await expect(noTrade.v.getPrice("MU")).rejects.toThrow(/no usable last trade price/);

    const zero = venue(() => ({ body: { trade: { p: 0 } } }));
    await expect(zero.v.getPrice("MU")).rejects.toThrow(/no usable last trade price/);
  });

  it("trades whole shares only, because OCO brackets reject fractions", async () => {
    const { v } = venue(() => ({ body: {} }));

    expect((await v.getFilters("MU")).amountStep).toBe(1);
    expect(await v.roundAmount("MU", 13.99)).toBe(13);
    expect(await v.roundAmount("MU", 0.8)).toBe(0);
  });

  it("rounds to the sub-penny tick rule", async () => {
    const { v } = venue(() => ({ body: {} }));

    expect(await v.roundPrice("MU", 61.4267)).toBe(61.43);
    expect(await v.roundPrice("PENNY", 0.123456)).toBe(0.1235);
  });
});

describe("AlpacaVenue — orders", () => {
  it("submits a DAY market buy and reports the real fill", async () => {
    const { v, calls } = venue((c) => {
      if (c.method === "POST") return { body: { id: "o1", status: "accepted" } };
      return {
        body: { id: "o1", status: "filled", filled_qty: "13", filled_avg_price: "61.55" },
      };
    });

    const receipt = await v.marketBuy("MU", 13);

    expect(receipt).toEqual({ id: "o1", amount: 13, price: 61.55 });
    expect(calls[0]!.body).toMatchObject({
      symbol: "MU",
      qty: "13",
      side: "buy",
      type: "market",
      // Never GTC: an unfilled market order must expire with the session, not
      // wake up and fill at tomorrow's open.
      time_in_force: "day",
    });
  });

  it("reports what actually filled, not what was requested", async () => {
    // The order never reaches a terminal state before the fill timeout, so
    // the venue returns the partial quantity. Bracketing 13 shares when only
    // 4 were bought would leave a naked sell order.
    const { v } = venue((c) =>
      c.method === "POST"
        ? { body: { id: "o2", status: "accepted" } }
        : {
            body: {
              id: "o2",
              status: "partially_filled",
              filled_qty: "4",
              filled_avg_price: "61.10",
            },
          }
    );

    expect(await v.marketBuy("MU", 13)).toEqual({ id: "o2", amount: 4, price: 61.1 });
  });

  it("throws when the broker cancels the order", async () => {
    const { v } = venue((c) =>
      c.method === "POST"
        ? { body: { id: "o2", status: "accepted" } }
        : { body: { id: "o2", status: "canceled" } }
    );

    await expect(v.marketBuy("MU", 13)).rejects.toThrow(/canceled/);
  });

  it("throws when the broker rejects the order", async () => {
    const { v } = venue((c) =>
      c.method === "POST"
        ? { body: { id: "o3", status: "accepted" } }
        : { body: { id: "o3", status: "rejected" } }
    );

    await expect(v.marketBuy("MU", 5)).rejects.toThrow(/rejected/);
  });

  it("places a GTC OCO sell bracket with both legs", async () => {
    const { v, calls } = venue(() => ({ body: { id: "oco1", status: "new" } }));

    const receipt = await v.placeOcoSell("MU", 13, {
      takeProfitPrice: 66.4,
      stopPrice: 58.4,
      stopLimitPrice: 58.1,
    });

    expect(receipt).toMatchObject({ id: "oco1", amount: 13 });
    expect(calls[0]!.body).toMatchObject({
      symbol: "MU",
      qty: "13",
      side: "sell",
      type: "limit",
      order_class: "oco",
      // GTC so the position stays protected overnight.
      time_in_force: "gtc",
      take_profit: { limit_price: "66.4" },
      stop_loss: { stop_price: "58.4", limit_price: "58.1" },
    });
  });

  it("refuses to bracket less than one share", async () => {
    const { v } = venue(() => ({ body: {} }));

    await expect(
      v.placeOcoSell("MU", 0.5, { takeProfitPrice: 1, stopPrice: 1, stopLimitPrice: 1 })
    ).rejects.toThrow(/whole shares only/);
  });

  it("treats a resting leg as an open bracket even when the parent is not", async () => {
    const { v } = venue(() => ({
      body: { id: "oco1", status: "filled", legs: [{ id: "l1", status: "new" }] },
    }));

    expect(await v.isOrderOpen("MU", "oco1")).toBe(true);
  });

  it("treats a vanished order as closed so boot reconciliation can proceed", async () => {
    const { v } = venue(() => ({ status: 404, body: { message: "order not found" } }));

    expect(await v.isOrderOpen("MU", "gone")).toBe(false);
  });

  it("propagates non-404 errors instead of guessing the position is closed", async () => {
    const { v } = venue(() => ({ status: 500, body: { message: "boom" } }));

    await expect(v.isOrderOpen("MU", "o1")).rejects.toThrow(AlpacaApiError);
  });

  it("authenticates every request with the Alpaca key headers", async () => {
    const impl = vi.fn(async () => new Response(JSON.stringify({ trade: { p: 1 } })));
    const v = new AlpacaVenue({
      apiKey: "my-key",
      apiSecret: "my-secret",
      fetchImpl: impl as unknown as typeof fetch,
    });

    await v.getPrice("MU");

    const headers = (impl.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["APCA-API-KEY-ID"]).toBe("my-key");
    expect(headers["APCA-API-SECRET-KEY"]).toBe("my-secret");
  });

  it("uses the paper host by default and the live host only when asked", async () => {
    const paper = venue(() => ({ body: { id: "o", status: "filled", filled_qty: "1" } }));
    await paper.v.marketBuy("MU", 1);
    expect(paper.calls[0]!.url).toContain("paper-api.alpaca.markets");

    const { impl, calls } = fakeFetch(() => ({
      body: { id: "o", status: "filled", filled_qty: "1" },
    }));
    const live = new AlpacaVenue({
      apiKey: "k",
      apiSecret: "s",
      paper: false,
      fetchImpl: impl,
      sleepImpl: async () => undefined,
    });
    await live.marketBuy("MU", 1);
    expect(calls[0]!.url).toBe("https://api.alpaca.markets/v2/orders");
  });
});

describe("AlpacaVenue — account and clock", () => {
  it("reads the market clock", async () => {
    const { v } = venue(() => ({
      body: { is_open: false, next_open: "2026-08-03T13:30:00Z", next_close: "" },
    }));

    expect(await v.getClock()).toMatchObject({
      isOpen: false,
      nextOpen: "2026-08-03T13:30:00Z",
    });
  });

  it("reads equity and the broker's own PDT flag", async () => {
    const { v } = venue(() => ({
      body: {
        equity: "12500.42",
        pattern_day_trader: true,
        trading_blocked: false,
        account_blocked: false,
      },
    }));

    expect(await v.getAccount()).toEqual({
      equity: 12500.42,
      patternDayTrader: true,
      tradingBlocked: false,
      accountBlocked: false,
    });
  });
});
