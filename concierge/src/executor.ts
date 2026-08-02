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
 *
 * All mutable state (positions, daily tally, idempotency, equity, kill
 * switch) is written through to a StateStore so a restart resumes cleanly;
 * reconcileOnBoot() then squares persisted positions against the exchange.
 */

import type { RiskConfig } from "./config.js";
import { type Journal, NoopJournal } from "./journal.js";
import type { Notifier } from "./notifier.js";
import { computeBracket, computePositionSize } from "./risk.js";
import { InMemoryStore, type OpenPosition, type StateStore } from "./store.js";
import type { ExecutionVenue } from "./venue.js";

export type { OpenPosition } from "./store.js";

/** Normalised view of the freqtrade webhook payload the executor needs. */
export interface SignalInput {
  type: string;
  trade_id: string;
  pair: string;
  /** Entry price for entries; exit price for exits. */
  rate: number;
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
  /** Currency label used in alerts. Defaults to USDT (crypto). */
  quoteCurrency?: string;
  /** Durable state; defaults to in-memory (tests / no-persistence runs). */
  store?: StateStore;
  /** Execution journal; defaults to no-op. */
  journal?: Journal;
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
  private readonly store: StateStore;
  private readonly journal: Journal;
  private readonly now: () => Date;
  private readonly quote: string;

  // In-memory working copy, loaded from and written through to the store.
  private killSwitch: boolean;
  private equity: number;
  private dailyLossQuote: number;
  private dailyKey: string;
  private readonly positions = new Map<string, OpenPosition>();

  constructor(deps: ExecutorDeps) {
    this.venue = deps.venue;
    this.notifier = deps.notifier;
    this.risk = deps.risk;
    this.store = deps.store ?? new InMemoryStore();
    this.journal = deps.journal ?? new NoopJournal();
    this.now = deps.now ?? (() => new Date());
    this.quote = deps.quoteCurrency ?? "USDT";

    // Persisted settings win over config defaults so runtime changes survive
    // a restart; otherwise seed the store from config.
    const ks = this.store.getSetting("kill_switch");
    this.killSwitch = ks !== undefined ? ks === "1" : deps.killSwitch;
    this.store.setSetting("kill_switch", this.killSwitch ? "1" : "0");

    const eq = this.store.getSetting("equity");
    this.equity = eq !== undefined ? Number(eq) : deps.risk.equity;
    this.store.setSetting("equity", String(this.equity));

    const daily = this.store.getDaily();
    if (daily) {
      this.dailyKey = daily.dayKey;
      this.dailyLossQuote = daily.lossQuote;
    } else {
      this.dailyKey = sastDayKey(this.now());
      this.dailyLossQuote = 0;
      this.store.setDaily({ dayKey: this.dailyKey, lossQuote: 0 });
    }

    for (const p of this.store.loadPositions()) this.positions.set(p.tradeId, p);
  }

  setKillSwitch(on: boolean): void {
    this.killSwitch = on;
    this.store.setSetting("kill_switch", on ? "1" : "0");
  }

  isKillSwitchOn(): boolean {
    return this.killSwitch;
  }

  setEquity(equity: number): void {
    this.equity = equity;
    this.store.setSetting("equity", String(equity));
  }

  getEquity(): number {
    return this.equity;
  }

  getRiskConfig(): RiskConfig {
    return this.risk;
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
      this.store.setDaily({ dayKey: key, lossQuote: 0 });
    }
  }

  private addDailyLoss(amount: number): void {
    this.rollDailyWindow();
    this.dailyLossQuote += amount;
    this.store.setDaily({ dayKey: this.dailyKey, lossQuote: this.dailyLossQuote });
  }

  /**
   * Square persisted positions against the exchange after a restart. If a
   * position's protective bracket is no longer resting, it almost certainly
   * filled (TP or SL) while we were down — drop it and flag for the journal
   * to reconcile realized P&L. Positions that were left unprotected (no OCO)
   * are surfaced loudly for a manual check.
   */
  async reconcileOnBoot(): Promise<void> {
    const positions = this.getOpenPositions();
    if (positions.length === 0) return;
    await this.notifier.notify(`🔄 Reconciling ${positions.length} open position(s) on boot…`);

    for (const pos of positions) {
      if (!pos.ocoOrderId) {
        await this.notifier.notify(
          `⚠️ #${pos.tradeId} ${pos.symbol}: tracked but has NO bracket — verify on Binance.`
        );
        continue;
      }
      let stillOpen: boolean;
      try {
        stillOpen = await this.venue.isOrderOpen(pos.symbol, pos.ocoOrderId);
      } catch (err) {
        await this.notifier.notify(
          `⚠️ #${pos.tradeId} ${pos.symbol}: could not check bracket on boot ` +
            `(${(err as Error).message}); leaving as open.`
        );
        continue;
      }
      if (!stillOpen) {
        this.positions.delete(pos.tradeId);
        this.store.deletePosition(pos.tradeId);
        await this.notifier.notify(
          `↩️ #${pos.tradeId} ${pos.symbol}: bracket resolved while offline — ` +
            `position closed. P&L reconciled by the journal sync.`
        );
      }
    }
  }

  async handleEntry(signal: SignalInput): Promise<EntryOutcome> {
    const { trade_id: tradeId, pair: symbol, rate: entry } = signal;

    if (this.killSwitch) {
      return this.skipEntry(tradeId, symbol, entry, "kill switch engaged — notify only");
    }

    this.rollDailyWindow();
    if (this.dailyLossQuote >= this.equity * this.risk.dailyLossLimit) {
      return this.skipEntry(
        tradeId,
        symbol,
        entry,
        `daily loss limit reached — entries suppressed until 00:00 SAST`
      );
    }

    if (this.store.isHandled(tradeId)) {
      return this.skipEntry(tradeId, symbol, entry, "duplicate entry signal (already handled)");
    }

    const sizing = computePositionSize({
      equity: this.equity,
      riskPerTrade: this.risk.riskPerTrade,
      maxPositionPct: this.risk.maxPositionPct,
      entry,
      stopPrice: entry * (1 - this.risk.stopLossPct),
    });
    if (!sizing.ok) {
      return this.skipEntry(tradeId, symbol, entry, `risk rejected: ${sizing.reason}`);
    }

    // Round to the exchange step size and enforce the minimum notional.
    const filters = await this.venue.getFilters(symbol);
    const amount = await this.venue.roundAmount(symbol, sizing.baseAmount);
    if (!(amount > 0)) {
      return this.skipEntry(tradeId, symbol, entry, "size rounds to zero at exchange step size");
    }
    if (filters.minNotional !== undefined && amount * entry < filters.minNotional) {
      return this.skipEntry(
        tradeId,
        symbol,
        entry,
        `notional ${(amount * entry).toFixed(2)} below min ${filters.minNotional}`
      );
    }

    // Mark handled (persisted) BEFORE placing so a retried webhook can't
    // double-buy even if the buy call is slow or the process restarts.
    this.store.markHandled(tradeId);

    const buy = await this.venue.marketBuy(symbol, amount);
    const fillPrice = buy.price ?? entry;

    // Derive the bracket from the ACTUAL fill, not the signal price. The
    // signal can be stale or (on testnet) far from the venue's market, and a
    // stop computed off a stale price can land on the wrong side of the
    // market — Binance rejects that OCO (-2010). Bracketing off the fill
    // keeps the stop below and the TP above the real entry, always.
    const rawBracket = computeBracket(fillPrice, {
      stopLossPct: this.risk.stopLossPct,
      stopLimitOffsetPct: this.risk.stopLimitOffsetPct,
      takeProfitPct: this.risk.takeProfitPct,
    });
    const bracket = {
      takeProfitPrice: await this.venue.roundPrice(symbol, rawBracket.takeProfitPrice),
      stopPrice: await this.venue.roundPrice(symbol, rawBracket.stopPrice),
      stopLimitPrice: await this.venue.roundPrice(symbol, rawBracket.stopLimitPrice),
    };

    let ocoId: string | undefined;
    try {
      const oco = await this.venue.placeOcoSell(symbol, buy.amount, bracket);
      ocoId = oco.id;
    } catch (err) {
      await this.notifier.notify(
        `⚠️ #${tradeId} ${symbol}: bought ${buy.amount} but OCO bracket FAILED ` +
          `(${(err as Error).message}). Position is UNPROTECTED.`
      );
    }

    const position: OpenPosition = {
      tradeId,
      symbol,
      amount: buy.amount,
      entryPrice: fillPrice,
      stopPrice: bracket.stopPrice,
      ocoOrderId: ocoId,
      openedAt: this.now().toISOString(),
    };
    this.positions.set(tradeId, position);
    this.store.savePosition(position);

    this.journal.record({
      ts: this.now().toISOString(),
      tradeId,
      symbol,
      kind: "entry",
      status: "placed",
      signalPrice: entry,
      fillPrice,
      amount: buy.amount,
      stakeQuote: sizing.stakeQuote,
      realizedQuote: null,
      reason: ocoId ? null : "no-bracket",
    });

    await this.notifier.notify(
      `🟢 AUTO-ENTRY #${tradeId} ${symbol}: bought ${buy.amount} @ ~${fillPrice} ` +
        `(${sizing.stakeQuote.toFixed(2)} ${this.quote}${sizing.clampedToMaxPosition ? ", clamped" : ""}) ` +
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

    if (realizedQuote < 0) this.addDailyLoss(-realizedQuote);

    this.positions.delete(tradeId);
    this.store.deletePosition(tradeId);

    this.journal.record({
      ts: this.now().toISOString(),
      tradeId,
      symbol: pos.symbol,
      kind: "exit",
      status: "closed",
      signalPrice: exitPrice,
      fillPrice: sell.price ?? null,
      amount: pos.amount,
      stakeQuote: null,
      realizedQuote,
      reason: null,
    });

    await this.notifier.notify(
      `🔴 AUTO-EXIT #${tradeId} ${pos.symbol}: sold ${pos.amount} @ ~${sell.price ?? exitPrice} ` +
        `| realized ${realizedQuote >= 0 ? "+" : ""}${realizedQuote.toFixed(2)} ${this.quote}`
    );
    return { action: "closed", tradeId, realizedQuote };
  }

  private async skipEntry(
    tradeId: string,
    symbol: string,
    signalPrice: number,
    reason: string
  ): Promise<EntryOutcome> {
    this.journal.record({
      ts: this.now().toISOString(),
      tradeId,
      symbol,
      kind: "skip",
      status: "skipped",
      signalPrice,
      fillPrice: null,
      amount: null,
      stakeQuote: null,
      realizedQuote: null,
      reason,
    });
    await this.notifier.notify(`⏭️ ENTRY #${tradeId} skipped: ${reason}`);
    return { action: "skipped", tradeId, reason };
  }
}
