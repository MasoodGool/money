/**
 * Executor: turns a freqtrade signal into real orders, fully autonomously.
 *
 * Every entry passes these guards in order, and any failure degrades to a
 * notification rather than an order (a signal is never silently dropped):
 *   1. kill switch        — master cut-off, default armed-off
 *   2. daily-loss breaker  — suppress entries after the daily loss limit
 *   3. idempotency         — one entry per freqtrade trade_id
 *   4. risk sizing         — 1% rule + max-position clamp (risk.ts)
 *   5. exchange filters    — step-size rounding + min-notional check
 * Only then: market buy, followed by a resting OCO stop/TP bracket so the
 * position is protected even if this process dies.
 */

import type { RiskConfig } from "./config.js";
import type { Notifier } from "./notifier.js";
import { computeBracket, computePositionSize } from "./risk.js";
import type { ExecutionVenue } from "./venue.js";

/** Normalised view of the freqtrade webhook payload the executor needs. */
export interface SignalInput {
  type: string;
  trade_id: string;
  pair: string;
  /** Entry price for entries; exit price for exits. */
  rate: number;
}

export interface OpenPosition {
  tradeId: string;
  symbol: string;
  amount: number;
  entryPrice: number;
  stopPrice: number;
  ocoOrderId: string | undefined;
}

export type EntryOutcome =
  | { action: "placed"; tradeId: string; amount: number; stakeQuote: number }
  | { action: "skipped"; tradeId: string; reason: string };

export type ExitOutcome =
  | { action: "closed"; tradeId: string; realizedQuote: number }
  | { action: "skipped"; tradeId: string; reason: string };

export interface ExecutorDeps {
  venue: ExecutionVenue;
  notifier: Notifier;
  risk: RiskConfig;
  /** Master cut-off. When true, no orders are placed. */
  killSwitch: boolean;
  /** Clock injection for deterministic daily-reset tests. */
  now?: () => Date;
}

/** SAST is UTC+2, no DST. The daily-loss window resets at 00:00 SAST. */
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

function sastDayKey(d: Date): string {
  return new Date(d.getTime() + SAST_OFFSET_MS).toISOString().slice(0, 10);
}

export class Executor {
  private readonly venue: ExecutionVenue;
  private readonly notifier: Notifier;
  private readonly risk: RiskConfig;
  private readonly now: () => Date;

  private killSwitch: boolean;
  private equity: number;
  private dailyLossQuote = 0;
  private dailyKey: string;
  private readonly positions = new Map<string, OpenPosition>();
  /** trade_ids we have already acted on, for idempotent webhook delivery. */
  private readonly handledEntries = new Set<string>();

  constructor(deps: ExecutorDeps) {
    this.venue = deps.venue;
    this.notifier = deps.notifier;
    this.risk = deps.risk;
    this.killSwitch = deps.killSwitch;
    this.now = deps.now ?? (() => new Date());
    this.equity = deps.risk.equity;
    this.dailyKey = sastDayKey(this.now());
  }

  setKillSwitch(on: boolean): void {
    this.killSwitch = on;
  }

  setEquity(equity: number): void {
    this.equity = equity;
  }

  getOpenPositions(): OpenPosition[] {
    return [...this.positions.values()];
  }

  /** Remaining daily loss budget in quote currency (never negative). */
  remainingDailyBudget(): number {
    this.rollDailyWindow();
    return Math.max(0, this.equity * this.risk.dailyLossLimit - this.dailyLossQuote);
  }

  private rollDailyWindow(): void {
    const key = sastDayKey(this.now());
    if (key !== this.dailyKey) {
      this.dailyKey = key;
      this.dailyLossQuote = 0;
    }
  }

  async handleEntry(signal: SignalInput): Promise<EntryOutcome> {
    const { trade_id: tradeId, pair: symbol, rate: entry } = signal;

    if (this.killSwitch) {
      return this.skipEntry(tradeId, "kill switch engaged — notify only");
    }

    this.rollDailyWindow();
    if (this.dailyLossQuote >= this.equity * this.risk.dailyLossLimit) {
      return this.skipEntry(
        tradeId,
        `daily loss limit reached — entries suppressed until 00:00 SAST`
      );
    }

    if (this.handledEntries.has(tradeId)) {
      return this.skipEntry(tradeId, "duplicate entry signal (already handled)");
    }

    const sizing = computePositionSize({
      equity: this.equity,
      riskPerTrade: this.risk.riskPerTrade,
      maxPositionPct: this.risk.maxPositionPct,
      entry,
      stopPrice: entry * (1 - this.risk.stopLossPct),
    });
    if (!sizing.ok) {
      return this.skipEntry(tradeId, `risk rejected: ${sizing.reason}`);
    }

    // Round to the exchange step size and enforce the minimum notional.
    const filters = await this.venue.getFilters(symbol);
    const amount = await this.venue.roundAmount(symbol, sizing.baseAmount);
    if (!(amount > 0)) {
      return this.skipEntry(tradeId, "size rounds to zero at exchange step size");
    }
    if (filters.minNotional !== undefined && amount * entry < filters.minNotional) {
      return this.skipEntry(
        tradeId,
        `notional ${(amount * entry).toFixed(2)} below min ${filters.minNotional}`
      );
    }

    // Mark handled BEFORE placing so a retried webhook can't double-buy even
    // if the buy call is slow.
    this.handledEntries.add(tradeId);

    const rawBracket = computeBracket(entry, {
      stopLossPct: this.risk.stopLossPct,
      stopLimitOffsetPct: this.risk.stopLimitOffsetPct,
      takeProfitPct: this.risk.takeProfitPct,
    });
    const bracket = {
      takeProfitPrice: await this.venue.roundPrice(symbol, rawBracket.takeProfitPrice),
      stopPrice: await this.venue.roundPrice(symbol, rawBracket.stopPrice),
      stopLimitPrice: await this.venue.roundPrice(symbol, rawBracket.stopLimitPrice),
    };

    const buy = await this.venue.marketBuy(symbol, amount);
    const fillPrice = buy.price ?? entry;

    let ocoId: string | undefined;
    try {
      const oco = await this.venue.placeOcoSell(symbol, buy.amount, bracket);
      ocoId = oco.id;
    } catch (err) {
      // Position is open but unprotected — surface loudly; do not pretend.
      await this.notifier.notify(
        `⚠️ #${tradeId} ${symbol}: bought ${buy.amount} but OCO bracket FAILED ` +
          `(${(err as Error).message}). Position is UNPROTECTED.`
      );
    }

    this.positions.set(tradeId, {
      tradeId,
      symbol,
      amount: buy.amount,
      entryPrice: fillPrice,
      stopPrice: bracket.stopPrice,
      ocoOrderId: ocoId,
    });

    await this.notifier.notify(
      `🟢 AUTO-ENTRY #${tradeId} ${symbol}: bought ${buy.amount} @ ~${fillPrice} ` +
        `(${sizing.stakeQuote.toFixed(2)} USDT${sizing.clampedToMaxPosition ? ", clamped" : ""}) ` +
        `| stop ${bracket.stopPrice} TP ${bracket.takeProfitPrice}` +
        (ocoId ? ` | OCO ${ocoId}` : " | ⚠️ no bracket")
    );
    return { action: "placed", tradeId, amount: buy.amount, stakeQuote: sizing.stakeQuote };
  }

  async handleExit(signal: SignalInput): Promise<ExitOutcome> {
    const { trade_id: tradeId, rate: exitPrice } = signal;
    const pos = this.positions.get(tradeId);
    if (!pos) {
      return { action: "skipped", tradeId, reason: "no open position for trade_id" };
    }

    // Cancel the resting bracket first so it can't race the close.
    if (pos.ocoOrderId) {
      try {
        await this.venue.cancelOrder(pos.symbol, pos.ocoOrderId);
      } catch (err) {
        await this.notifier.notify(
          `⚠️ #${tradeId} ${pos.symbol}: failed to cancel OCO ${pos.ocoOrderId} ` +
            `(${(err as Error).message}); closing anyway.`
        );
      }
    }

    const sell = await this.venue.marketSell(pos.symbol, pos.amount);
    const realizedQuote = ((sell.price ?? exitPrice) - pos.entryPrice) * pos.amount;

    if (realizedQuote < 0) {
      this.rollDailyWindow();
      this.dailyLossQuote += -realizedQuote;
    }

    this.positions.delete(tradeId);
    await this.notifier.notify(
      `🔴 AUTO-EXIT #${tradeId} ${pos.symbol}: sold ${pos.amount} @ ~${sell.price ?? exitPrice} ` +
        `| realized ${realizedQuote >= 0 ? "+" : ""}${realizedQuote.toFixed(2)} USDT`
    );
    return { action: "closed", tradeId, realizedQuote };
  }

  private async skipEntry(tradeId: string, reason: string): Promise<EntryOutcome> {
    await this.notifier.notify(`⏭️ ENTRY #${tradeId} skipped: ${reason}`);
    return { action: "skipped", tradeId, reason };
  }
}
