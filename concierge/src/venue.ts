/**
 * ExecutionVenue abstracts the exchange so the executor's logic is testable
 * without network access. The ccxt/Binance specifics live in
 * binance-venue.ts; tests use an in-memory fake.
 */

/** Exchange trading filters for a symbol, used to round/validate orders. */
export interface MarketFilters {
  /** Quantity step size (LOT_SIZE filter). */
  amountStep: number;
  /** Price tick size (PRICE_FILTER). */
  priceTick: number;
  /** Minimum order notional in quote currency (MIN_NOTIONAL), if any. */
  minNotional: number | undefined;
}

export interface OcoBracket {
  takeProfitPrice: number;
  stopPrice: number;
  stopLimitPrice: number;
}

export interface OrderReceipt {
  /** Exchange order id (or order-list id for OCO). */
  id: string;
  /** Base quantity actually submitted, after step rounding. */
  amount: number;
  /** Average/limit fill price reported by the venue, if known. */
  price: number | undefined;
}

export interface ExecutionVenue {
  /** Load and cache symbol filters (precision, min notional). */
  getFilters(symbol: string): Promise<MarketFilters>;
  /** Round a base quantity down to the symbol's step size. */
  roundAmount(symbol: string, amount: number): Promise<number>;
  /** Round a price to the symbol's tick size. */
  roundPrice(symbol: string, price: number): Promise<number>;
  /** Market buy `amount` base units. */
  marketBuy(symbol: string, amount: number): Promise<OrderReceipt>;
  /** Market sell `amount` base units (used to close on exit). */
  marketSell(symbol: string, amount: number): Promise<OrderReceipt>;
  /** Place a resting OCO sell bracket protecting an open long. */
  placeOcoSell(symbol: string, amount: number, bracket: OcoBracket): Promise<OrderReceipt>;
  /** Cancel a previously placed order/order-list by id. */
  cancelOrder(symbol: string, id: string): Promise<void>;
}
