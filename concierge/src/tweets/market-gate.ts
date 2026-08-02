/**
 * MarketGate: is this venue in a state where we are allowed to trade at all?
 *
 * Separate from the risk gate (which decides size) and the tweet gates (which
 * decide intent). This answers venue-level questions the crypto path never
 * had to ask: is the exchange open, and would this trade break a regulatory
 * limit on the account?
 *
 * Entries and exits are gated differently on purpose. An exit is never
 * blocked by the day-trade limit: refusing to close a position would leave
 * real risk on the book to protect a compliance counter, which is backwards.
 * Both are blocked when the market is shut, because neither can fill.
 */

import type { AlpacaAccount, AlpacaClock } from "../alpaca-venue.js";
import type { DayTradeLedger } from "./day-trade-ledger.js";

export interface GateDecision {
  ok: boolean;
  reason?: string;
}

export interface MarketGate {
  canEnter(): Promise<GateDecision>;
  canExit(): Promise<GateDecision>;
  /** Called after a position closes so day trades can be counted. */
  recordClose(openedAt: string | undefined, closedAt: Date): void;
}

/** 24/7 venue with no regulatory day-trade limit — i.e. crypto. */
export class AlwaysOpenGate implements MarketGate {
  async canEnter(): Promise<GateDecision> {
    return { ok: true };
  }
  async canExit(): Promise<GateDecision> {
    return { ok: true };
  }
  recordClose(): void {}
}

/** The subset of the Alpaca venue this gate needs. */
export interface AlpacaGateSource {
  getClock(): Promise<AlpacaClock>;
  getAccount(): Promise<AlpacaAccount>;
}

export interface AlpacaMarketGateOptions {
  venue: AlpacaGateSource;
  ledger: DayTradeLedger;
  /** Day trades allowed under the equity floor. FINRA's limit is 3. */
  dayTradeLimit?: number;
  /** Equity above which the day-trade rule stops applying. */
  pdtEquityFloor?: number;
  now?: () => Date;
}

export class AlpacaMarketGate implements MarketGate {
  private readonly venue: AlpacaGateSource;
  private readonly ledger: DayTradeLedger;
  private readonly dayTradeLimit: number;
  private readonly pdtEquityFloor: number;
  private readonly now: () => Date;

  constructor(opts: AlpacaMarketGateOptions) {
    this.venue = opts.venue;
    this.ledger = opts.ledger;
    this.dayTradeLimit = opts.dayTradeLimit ?? 3;
    this.pdtEquityFloor = opts.pdtEquityFloor ?? 25_000;
    this.now = opts.now ?? (() => new Date());
  }

  async canEnter(): Promise<GateDecision> {
    const account = await this.venue.getAccount();
    const blocked = this.blockedReason(account);
    if (blocked) return { ok: false, reason: blocked };

    const clock = await this.venue.getClock();
    if (!clock.isOpen) {
      // Deliberately a refusal, not a queue. Holding a tweet until the open
      // and filling hours later is exactly the stale-call problem the
      // freshness gate exists to prevent.
      return {
        ok: false,
        reason: `market closed${clock.nextOpen ? ` until ${clock.nextOpen}` : ""}`,
      };
    }

    if (account.equity < this.pdtEquityFloor) {
      if (account.patternDayTrader) {
        return {
          ok: false,
          reason: `account flagged pattern-day-trader with equity ${account.equity.toFixed(0)} below ${this.pdtEquityFloor}`,
        };
      }
      const used = this.ledger.count(this.now());
      if (used >= this.dayTradeLimit) {
        return {
          ok: false,
          reason: `day-trade limit reached (${used}/${this.dayTradeLimit} in the last 5 business days, equity below ${this.pdtEquityFloor})`,
        };
      }
    }
    return { ok: true };
  }

  async canExit(): Promise<GateDecision> {
    const account = await this.venue.getAccount();
    const blocked = this.blockedReason(account);
    if (blocked) return { ok: false, reason: blocked };

    const clock = await this.venue.getClock();
    if (!clock.isOpen) {
      // The OCO bracket is still resting, so the position is not unprotected
      // while we wait for the open.
      return {
        ok: false,
        reason: `market closed${clock.nextOpen ? ` until ${clock.nextOpen}` : ""} — bracket still protecting the position`,
      };
    }
    return { ok: true };
  }

  recordClose(openedAt: string | undefined, closedAt: Date): void {
    this.ledger.recordClose(openedAt, closedAt);
  }

  private blockedReason(account: AlpacaAccount): string | undefined {
    if (account.accountBlocked) return "broker has blocked this account";
    if (account.tradingBlocked) return "broker has blocked trading on this account";
    return undefined;
  }
}
