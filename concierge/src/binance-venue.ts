/**
 * ccxt-backed Binance spot venue. This is the only file that talks to the
 * exchange; everything else works against the ExecutionVenue interface.
 *
 * TESTNET-FIRST: with `testnet: true` ccxt points at testnet.binance.vision
 * (fake balances, real API surface). The OCO bracket is placed via Binance's
 * order-list endpoint directly (ccxt's createOrder + stopLossPrice builds a
 * SINGLE conditional order, not a one-cancels-other bracket).
 */

import ccxt, { type Exchange } from "ccxt";

import type { ExecutionVenue, MarketFilters, OcoBracket, OrderReceipt } from "./venue.js";

export interface BinanceVenueOptions {
  apiKey: string;
  secret: string;
  testnet: boolean;
}

/** ccxt implicit (raw) Binance endpoints not surfaced on the typed Exchange. */
interface BinanceOcoApi {
  privatePostOrderListOco(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  privateDeleteOrderList(params: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export class CcxtBinanceVenue implements ExecutionVenue {
  private readonly exchange: Exchange;
  private marketsLoaded = false;

  constructor(opts: BinanceVenueOptions) {
    this.exchange = new ccxt.binance({
      apiKey: opts.apiKey,
      secret: opts.secret,
      enableRateLimit: true,
      options: { defaultType: "spot" },
    });
    // Routes all REST calls to the spot testnet base URLs.
    if (opts.testnet) this.exchange.setSandboxMode(true);
  }

  private async ensureMarkets(): Promise<void> {
    if (!this.marketsLoaded) {
      await this.exchange.loadMarkets();
      this.marketsLoaded = true;
    }
  }

  async getFilters(symbol: string): Promise<MarketFilters> {
    await this.ensureMarkets();
    const market = this.exchange.market(symbol);
    const amountStep =
      typeof market.precision.amount === "number" && market.precision.amount > 1
        ? 1 / 10 ** 0 // defensive; Binance reports step directly below
        : (market.limits?.amount?.min ?? 0);
    return {
      // ccxt normalises Binance LOT_SIZE / PRICE_FILTER into precision; the
      // *ToPrecision helpers below are what we actually round with.
      amountStep: amountStep || Number(market.precision.amount) || 0,
      priceTick: Number(market.precision.price) || 0,
      minNotional: market.limits?.cost?.min ?? undefined,
    };
  }

  async getPrice(symbol: string): Promise<number> {
    await this.ensureMarkets();
    const ticker = await this.exchange.fetchTicker(symbol);
    const price = ticker.last ?? ticker.close ?? ticker.bid;
    if (price === undefined || !Number.isFinite(price) || price <= 0) {
      throw new Error(`no usable price for ${symbol}`);
    }
    return Number(price);
  }

  async roundAmount(symbol: string, amount: number): Promise<number> {
    await this.ensureMarkets();
    return Number(this.exchange.amountToPrecision(symbol, amount));
  }

  async roundPrice(symbol: string, price: number): Promise<number> {
    await this.ensureMarkets();
    return Number(this.exchange.priceToPrecision(symbol, price));
  }

  async marketBuy(symbol: string, amount: number): Promise<OrderReceipt> {
    await this.ensureMarkets();
    const order = await this.exchange.createOrder(symbol, "market", "buy", amount);
    return {
      id: String(order.id),
      amount: Number(order.filled ?? order.amount ?? amount),
      price: order.average ?? order.price ?? undefined,
    };
  }

  async marketSell(symbol: string, amount: number): Promise<OrderReceipt> {
    await this.ensureMarkets();
    const order = await this.exchange.createOrder(symbol, "market", "sell", amount);
    return {
      id: String(order.id),
      amount: Number(order.filled ?? order.amount ?? amount),
      price: order.average ?? order.price ?? undefined,
    };
  }

  async placeOcoSell(
    symbol: string,
    amount: number,
    bracket: OcoBracket
  ): Promise<OrderReceipt> {
    await this.ensureMarkets();
    const market = this.exchange.market(symbol);
    const api = this.exchange as unknown as BinanceOcoApi;

    // Binance spot OCO (POST /api/v3/orderList/oco). For a SELL bracket
    // protecting a long position:
    //   above = take-profit  (LIMIT_MAKER resting above the market)
    //   below = stop-loss     (STOP_LOSS_LIMIT triggered below the market)
    // Only the stop-limit leg takes a timeInForce; adding one to LIMIT_MAKER
    // would be rejected as an unread parameter (-1104).
    //
    // MAINNET NOTE: spot market-buy fees are taken in the base asset, so the
    // free balance is slightly below `amount` (the filled qty). With testnet
    // commissions off this is exact; before mainnet, cap `amount` to the free
    // base balance or the OCO can fail with insufficient balance (-2010).
    const resp = await api.privatePostOrderListOco({
      symbol: market.id,
      side: "SELL",
      quantity: this.exchange.amountToPrecision(symbol, amount),
      aboveType: "LIMIT_MAKER",
      abovePrice: this.exchange.priceToPrecision(symbol, bracket.takeProfitPrice),
      belowType: "STOP_LOSS_LIMIT",
      belowStopPrice: this.exchange.priceToPrecision(symbol, bracket.stopPrice),
      belowPrice: this.exchange.priceToPrecision(symbol, bracket.stopLimitPrice),
      belowTimeInForce: "GTC",
    });

    return {
      // Track by the order-list id; isOrderOpen / cancel both key off it.
      id: String(resp["orderListId"]),
      amount,
      price: bracket.takeProfitPrice,
    };
  }

  async cancelOrder(symbol: string, id: string): Promise<void> {
    await this.ensureMarkets();
    const market = this.exchange.market(symbol);
    const api = this.exchange as unknown as BinanceOcoApi;
    // Cancel the whole OCO list by its id; fall back to a plain single-order
    // cancel if this id turns out not to be a list.
    try {
      await api.privateDeleteOrderList({ symbol: market.id, orderListId: id });
    } catch {
      await this.exchange.cancelOrder(id, symbol);
    }
  }

  async isOrderOpen(symbol: string, id: string): Promise<boolean> {
    await this.ensureMarkets();
    // If the id appears among open orders it's still resting. Anything else
    // (filled, cancelled, unknown) counts as not-open for reconciliation.
    const open = await this.exchange.fetchOpenOrders(symbol);
    return open.some((o) => String(o.id) === id || String(o.info?.orderListId) === id);
  }
}
