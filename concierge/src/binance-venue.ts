/**
 * ccxt-backed Binance spot venue. This is the only file that talks to the
 * exchange; everything else works against the ExecutionVenue interface.
 *
 * TESTNET-FIRST: with `testnet: true` ccxt points at testnet.binance.vision
 * (fake balances, real API surface). The OCO bracket below is the one piece
 * whose exact wire format is ccxt/Binance-version-sensitive — VALIDATE IT
 * AGAINST TESTNET before ever flipping to mainnet. That validation is the
 * whole reason testnet-first was chosen.
 */

import ccxt, { type Exchange } from "ccxt";

import type { ExecutionVenue, MarketFilters, OcoBracket, OrderReceipt } from "./venue.js";

export interface BinanceVenueOptions {
  apiKey: string;
  secret: string;
  testnet: boolean;
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
    // ccxt unified OCO: a limit sell at the take-profit, with stopLossPrice
    // (trigger) and the stop-limit price supplied via params. ccxt's binance
    // implementation routes this to the OCO order-list endpoint.
    const order = await this.exchange.createOrder(
      symbol,
      "limit",
      "sell",
      amount,
      bracket.takeProfitPrice,
      {
        stopLossPrice: bracket.stopPrice,
        price: bracket.stopLimitPrice,
        // Binance requires explicit stop-limit price for the SL leg.
        stopLimitPrice: bracket.stopLimitPrice,
      }
    );
    return {
      id: String(order.id),
      amount,
      price: bracket.takeProfitPrice,
    };
  }

  async cancelOrder(symbol: string, id: string): Promise<void> {
    await this.ensureMarkets();
    // Binance OCO lists cancel via the order-list id; fall back to plain
    // cancel for single orders.
    try {
      await this.exchange.cancelOrder(id, symbol, { orderListId: id });
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
