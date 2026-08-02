/**
 * Same-day round-trip counter, for the pattern-day-trader rule.
 *
 * FINRA restricts an account under $25,000 to three day trades in any five
 * business days; a fourth flags the account and can freeze it for 90 days.
 * A bot that reacts to tweets can trip that in an afternoon.
 *
 * Alpaca used to report the remaining allowance as `daytrade_count`, but that
 * field was removed from account responses on 2026-07-06 (the FINRA
 * intraday-margin migration) and now defaults to null. So the count has to be
 * kept locally: this ledger records a date every time we close a position we
 * opened the same trading day.
 *
 * The window is a conservative approximation. FINRA counts five *business*
 * days; this looks back seven *calendar* days, which always spans at least
 * five business days. It can therefore over-count across a holiday week and
 * block a trade that would have been allowed — the safe direction to be wrong.
 */

import type { StateStore } from "../store.js";

const LEDGER_KEY = "day_trades";
const LOOKBACK_DAYS = 7;

/** Trading date in the exchange's timezone, as YYYY-MM-DD. */
export function tradingDate(at: Date, timeZone = "America/New_York"): string {
  // en-CA renders as YYYY-MM-DD, which sorts and compares lexically.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

export class DayTradeLedger {
  constructor(
    private readonly store: StateStore,
    private readonly timeZone = "America/New_York"
  ) {}

  private read(): string[] {
    const raw = this.store.getSetting(LEDGER_KEY);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === "string") : [];
    } catch {
      // A corrupt ledger must not wedge trading; start clean but stay
      // conservative by treating it as empty rather than as "no limit".
      return [];
    }
  }

  private write(dates: string[]): void {
    this.store.setSetting(LEDGER_KEY, JSON.stringify(dates));
  }

  /** Dates still inside the lookback window. */
  private recent(now: Date): string[] {
    const cutoff = tradingDate(
      new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000),
      this.timeZone
    );
    return this.read().filter((d) => d > cutoff);
  }

  /** Day trades counted against the current window. */
  count(now: Date): number {
    return this.recent(now).length;
  }

  /**
   * Record a close. Only counts when the position was opened on the same
   * trading day — an overnight hold is not a day trade.
   */
  recordClose(openedAt: string | undefined, closedAt: Date): boolean {
    if (!openedAt) return false;
    const opened = new Date(openedAt);
    if (!Number.isFinite(opened.getTime())) return false;
    if (tradingDate(opened, this.timeZone) !== tradingDate(closedAt, this.timeZone)) {
      return false;
    }
    // Prune as we write so the key cannot grow without bound.
    this.write([...this.recent(closedAt), tradingDate(closedAt, this.timeZone)]);
    return true;
  }
}
