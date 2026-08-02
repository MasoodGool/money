/**
 * Alpaca (US equities) execution venue.
 *
 * The second `ExecutionVenue` implementation, alongside ccxt/Binance. The
 * executor, risk gate and bracket logic are unchanged — only the exchange
 * specifics live here.
 *
 * Equities are not crypto, and three differences are load-bearing:
 *
 *   1. WHOLE SHARES ONLY. Alpaca supports fractional quantities for plain
 *      market orders, but NOT for the advanced order classes — and every
 *      position we open must carry a protective OCO bracket. So the step size
 *      is 1 share, and sizing rounds down to it.
 *   2. OCO IS EXIT-ONLY. Alpaca's `order_class: "oco"` is a sell-side pair
 *      (take-profit limit + stop-loss) against an existing long. That is
 *      exactly the shape `placeOcoSell` already expects, so the executor's
 *      buy-then-bracket flow maps over cleanly — and keeps the advantage of
 *      deriving the bracket from the real fill price.
 *   3. FILLS ARE NOT SYNCHRONOUS. `POST /v2/orders` returns `accepted` with a
 *      null fill price. We poll briefly for the fill so the bracket is
 *      derived from the price we actually got, not the price we asked for.
 *
 * Market hours and the pattern-day-trader rule are NOT handled here — they
 * gate whether a trade should be attempted at all, and live in
 * `tweets/market-gate.ts`.
 */

import type { ExecutionVenue, MarketFilters, OcoBracket, OrderReceipt } from "./venue.js";

const PAPER_TRADING_HOST = "https://paper-api.alpaca.markets";
const LIVE_TRADING_HOST = "https://api.alpaca.markets";
const DATA_HOST = "https://data.alpaca.markets";

/** Order states that still rest on the book. */
const OPEN_STATUSES = new Set([
  "new",
  "accepted",
  "pending_new",
  "accepted_for_bidding",
  "partially_filled",
  "held",
  "replaced",
  "pending_replace",
  "calculated",
  "stopped",
  "suspended",
]);

/** Terminal states — polling a fill stops here. */
const TERMINAL_STATUSES = new Set([
  "filled",
  "canceled",
  "expired",
  "rejected",
  "done_for_day",
]);

export interface AlpacaVenueOptions {
  apiKey: string;
  apiSecret: string;
  /** Paper trading (fake money, real API). Defaults to true. */
  paper?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** How long to wait for a market order to report a fill. */
  fillTimeoutMs?: number;
  /** Poll interval while waiting for a fill. */
  fillPollMs?: number;
  /** Injectable sleep, so tests don't wait in real time. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface AlpacaClock {
  isOpen: boolean;
  nextOpen: string;
  nextClose: string;
}

export interface AlpacaAccount {
  equity: number;
  /** Broker's own PDT flag. */
  patternDayTrader: boolean;
  /** True when the broker has restricted the account from trading. */
  tradingBlocked: boolean;
  accountBlocked: boolean;
}

export class AlpacaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string
  ) {
    super(message);
    this.name = "AlpacaApiError";
  }
}

interface AlpacaOrder {
  id: string;
  status: string;
  qty?: string | null;
  filled_qty?: string | null;
  filled_avg_price?: string | null;
  legs?: AlpacaOrder[] | null;
}

export class AlpacaVenue implements ExecutionVenue {
  private readonly tradingHost: string;
  private readonly key: string;
  private readonly secret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly fillTimeoutMs: number;
  private readonly fillPollMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly paper: boolean;

  constructor(opts: AlpacaVenueOptions) {
    this.paper = opts.paper ?? true;
    this.tradingHost = this.paper ? PAPER_TRADING_HOST : LIVE_TRADING_HOST;
    this.key = opts.apiKey;
    this.secret = opts.apiSecret;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fillTimeoutMs = opts.fillTimeoutMs ?? 20_000;
    // Floor the poll interval: a zero here would spin the fill loop against
    // the orders endpoint until the timeout expired.
    this.fillPollMs = Math.max(25, opts.fillPollMs ?? 500);
    this.sleep = opts.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async call(
    url: string,
    init: { method?: string; body?: unknown } = {}
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: init.method ?? "GET",
        headers: {
          "APCA-API-KEY-ID": this.key,
          "APCA-API-SECRET-KEY": this.secret,
          "Content-Type": "application/json",
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new AlpacaApiError(
          `Alpaca ${res.status} ${init.method ?? "GET"} ${url.replace(/\?.*$/, "")}: ${text.slice(0, 300)}`,
          res.status,
          text
        );
      }
      return text === "" ? {} : (JSON.parse(text) as unknown);
    } finally {
      clearTimeout(timer);
    }
  }

  // --- market data -------------------------------------------------------

  async getPrice(symbol: string): Promise<number> {
    const payload = (await this.call(
      `${DATA_HOST}/v2/stocks/${encodeURIComponent(symbol)}/trades/latest`
    )) as { trade?: { p?: number } };
    const price = payload.trade?.p;
    if (price === undefined || !Number.isFinite(price) || price <= 0) {
      throw new Error(`no usable last trade price for ${symbol}`);
    }
    return Number(price);
  }

  /**
   * Equity order constraints.
   *
   * Whole shares (see the header note on fractional + OCO), a one-cent tick
   * above $1.00, and no exchange minimum notional — a single share is a valid
   * order. The 1%-rule sizing is what keeps orders sensibly sized.
   */
  async getFilters(_symbol: string): Promise<MarketFilters> {
    return { amountStep: 1, priceTick: 0.01, minNotional: undefined };
  }

  async roundAmount(_symbol: string, amount: number): Promise<number> {
    return Math.floor(amount);
  }

  async roundPrice(_symbol: string, price: number): Promise<number> {
    // Sub-penny rule: quotes at or above $1.00 tick in cents; below $1.00
    // they tick in hundredths of a cent.
    const decimals = price >= 1 ? 2 : 4;
    return Number(price.toFixed(decimals));
  }

  // --- orders ------------------------------------------------------------

  async marketBuy(symbol: string, amount: number): Promise<OrderReceipt> {
    return this.marketOrder(symbol, amount, "buy");
  }

  async marketSell(symbol: string, amount: number): Promise<OrderReceipt> {
    return this.marketOrder(symbol, amount, "sell");
  }

  private async marketOrder(
    symbol: string,
    amount: number,
    side: "buy" | "sell"
  ): Promise<OrderReceipt> {
    const order = (await this.call(`${this.tradingHost}/v2/orders`, {
      method: "POST",
      body: {
        symbol,
        qty: String(amount),
        side,
        type: "market",
        // DAY, not GTC: a market order that could not fill during this
        // session must expire, never wake up and fill at tomorrow's open.
        time_in_force: "day",
      },
    })) as AlpacaOrder;

    const filled = await this.waitForFill(order);
    const filledQty = Number(filled.filled_qty ?? 0);
    const avg = filled.filled_avg_price ? Number(filled.filled_avg_price) : undefined;

    if (filled.status === "rejected" || filled.status === "canceled") {
      throw new Error(`Alpaca ${side} order ${filled.id} ${filled.status}`);
    }
    return {
      id: String(filled.id),
      // Report what actually filled. A partial fill must not be bracketed as
      // if the whole order had gone through.
      amount: filledQty > 0 ? filledQty : amount,
      price: avg !== undefined && Number.isFinite(avg) ? avg : undefined,
    };
  }

  /** Poll an order until it reaches a terminal state or the timeout expires. */
  private async waitForFill(order: AlpacaOrder): Promise<AlpacaOrder> {
    let current = order;
    const deadline = Date.now() + this.fillTimeoutMs;
    while (!TERMINAL_STATUSES.has(current.status) && Date.now() < deadline) {
      await this.sleep(this.fillPollMs);
      current = (await this.call(
        `${this.tradingHost}/v2/orders/${current.id}`
      )) as AlpacaOrder;
    }
    return current;
  }

  /**
   * Attach a protective OCO bracket to an open long: a take-profit limit
   * above and a stop-loss below, either one cancelling the other.
   */
  async placeOcoSell(
    symbol: string,
    amount: number,
    bracket: OcoBracket
  ): Promise<OrderReceipt> {
    const shares = Math.floor(amount);
    if (shares < 1) {
      throw new Error(`cannot bracket ${amount} shares of ${symbol} (whole shares only)`);
    }
    const order = (await this.call(`${this.tradingHost}/v2/orders`, {
      method: "POST",
      body: {
        symbol,
        qty: String(shares),
        side: "sell",
        type: "limit",
        // GTC so the bracket survives the session — an open position must
        // stay protected overnight.
        time_in_force: "gtc",
        order_class: "oco",
        take_profit: { limit_price: String(bracket.takeProfitPrice) },
        stop_loss: {
          stop_price: String(bracket.stopPrice),
          limit_price: String(bracket.stopLimitPrice),
        },
      },
    })) as AlpacaOrder;

    return { id: String(order.id), amount: shares, price: bracket.takeProfitPrice };
  }

  async cancelOrder(_symbol: string, id: string): Promise<void> {
    // Cancelling the OCO parent cancels both legs.
    await this.call(`${this.tradingHost}/v2/orders/${id}`, { method: "DELETE" });
  }

  async isOrderOpen(_symbol: string, id: string): Promise<boolean> {
    let order: AlpacaOrder;
    try {
      order = (await this.call(`${this.tradingHost}/v2/orders/${id}`)) as AlpacaOrder;
    } catch (err) {
      // A 404 means the order is gone — treat that as "no longer resting" so
      // boot reconciliation can close the position out.
      if (err instanceof AlpacaApiError && err.status === 404) return false;
      throw err;
    }
    if (OPEN_STATUSES.has(order.status)) return true;
    // An OCO parent can report a terminal status while a leg still rests.
    return (order.legs ?? []).some((leg) => OPEN_STATUSES.has(leg.status));
  }

  // --- account / calendar (used by the market gate) ----------------------

  async getClock(): Promise<AlpacaClock> {
    const c = (await this.call(`${this.tradingHost}/v2/clock`)) as {
      is_open?: boolean;
      next_open?: string;
      next_close?: string;
    };
    return {
      isOpen: c.is_open === true,
      nextOpen: c.next_open ?? "",
      nextClose: c.next_close ?? "",
    };
  }

  async getAccount(): Promise<AlpacaAccount> {
    const a = (await this.call(`${this.tradingHost}/v2/account`)) as {
      equity?: string;
      pattern_day_trader?: boolean;
      trading_blocked?: boolean;
      account_blocked?: boolean;
    };
    return {
      equity: Number(a.equity ?? 0),
      patternDayTrader: a.pattern_day_trader === true,
      tradingBlocked: a.trading_blocked === true,
      accountBlocked: a.account_blocked === true,
    };
  }
}
