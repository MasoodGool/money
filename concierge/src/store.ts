/**
 * Durable executor state. An autonomous bot that loses its open positions,
 * daily-loss tally, or idempotency set on restart is unsafe — a redelivered
 * webhook could re-buy, the daily breaker would reset mid-day, and exits
 * would fail to match. The executor writes through to a StateStore on every
 * mutation and reloads from it on boot.
 */

export interface OpenPosition {
  tradeId: string;
  symbol: string;
  amount: number;
  entryPrice: number;
  stopPrice: number;
  /** OCO order-list id protecting the position, if the bracket was placed. */
  ocoOrderId: string | undefined;
  /**
   * ISO timestamp of the entry fill. Needed to tell a same-day round trip
   * (a day trade, which is regulated on equities) from an overnight hold.
   */
  openedAt: string;
}

export interface DailyState {
  /** SAST day key (YYYY-MM-DD) the loss tally belongs to. */
  dayKey: string;
  /** Realized loss accumulated within dayKey, in quote currency (>= 0). */
  lossQuote: number;
}

export interface StateStore {
  loadPositions(): OpenPosition[];
  savePosition(p: OpenPosition): void;
  deletePosition(tradeId: string): void;

  isHandled(tradeId: string): boolean;
  markHandled(tradeId: string): void;

  getDaily(): DailyState | undefined;
  setDaily(state: DailyState): void;

  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
}

/** Volatile store for tests and for runs where persistence isn't wanted. */
export class InMemoryStore implements StateStore {
  private positions = new Map<string, OpenPosition>();
  private handled = new Set<string>();
  private daily: DailyState | undefined;
  private settings = new Map<string, string>();

  loadPositions(): OpenPosition[] {
    return [...this.positions.values()];
  }
  savePosition(p: OpenPosition): void {
    this.positions.set(p.tradeId, p);
  }
  deletePosition(tradeId: string): void {
    this.positions.delete(tradeId);
  }
  isHandled(tradeId: string): boolean {
    return this.handled.has(tradeId);
  }
  markHandled(tradeId: string): void {
    this.handled.add(tradeId);
  }
  getDaily(): DailyState | undefined {
    return this.daily;
  }
  setDaily(state: DailyState): void {
    this.daily = state;
  }
  getSetting(key: string): string | undefined {
    return this.settings.get(key);
  }
  setSetting(key: string, value: string): void {
    this.settings.set(key, value);
  }
}
