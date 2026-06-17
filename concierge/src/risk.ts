/**
 * Position sizing and risk clamps. Pure functions, no I/O — this is the
 * gate every order passes through before it can reach the exchange.
 *
 * The 1% rule: risk at most `riskPerTrade` of equity on the distance between
 * entry and stop. size = (equity * riskPerTrade) / (entry - stop).
 */

export interface SizingInput {
  equity: number;
  riskPerTrade: number;
  maxPositionPct: number;
  /** Intended entry price (quote per base). */
  entry: number;
  /** Protective stop price. For a long, must be strictly below entry. */
  stopPrice: number;
}

export type SizingResult =
  | {
      ok: true;
      /** Quantity in base asset, before exchange step-size rounding. */
      baseAmount: number;
      /** Notional in quote currency (baseAmount * entry). */
      stakeQuote: number;
      /** True when the 1% risk size was reduced to honour maxPositionPct. */
      clampedToMaxPosition: boolean;
    }
  | { ok: false; reason: string };

/**
 * Compute a long position size from the 1% risk rule, clamped to the max
 * position cap. Rejects degenerate inputs rather than guessing — a bad stop
 * distance must never silently become an oversized position.
 */
export function computePositionSize(input: SizingInput): SizingResult {
  const { equity, riskPerTrade, maxPositionPct, entry, stopPrice } = input;

  if (!(equity > 0)) return { ok: false, reason: `non-positive equity (${equity})` };
  if (!(entry > 0)) return { ok: false, reason: `non-positive entry (${entry})` };
  if (!(riskPerTrade > 0)) {
    return { ok: false, reason: `non-positive risk_per_trade (${riskPerTrade})` };
  }

  const stopDistance = entry - stopPrice;
  if (!(stopDistance > 0)) {
    // Stop at/above entry => zero or negative risk distance => undefined size.
    return {
      ok: false,
      reason: `stop (${stopPrice}) must be strictly below entry (${entry})`,
    };
  }

  const riskQuote = equity * riskPerTrade;
  let baseAmount = riskQuote / stopDistance;
  let stakeQuote = baseAmount * entry;

  // Clamp to the max position cap: a tight stop can imply a position larger
  // than we ever want exposed on one trade.
  const maxStakeQuote = equity * maxPositionPct;
  let clampedToMaxPosition = false;
  if (stakeQuote > maxStakeQuote) {
    stakeQuote = maxStakeQuote;
    baseAmount = stakeQuote / entry;
    clampedToMaxPosition = true;
  }

  if (!(baseAmount > 0)) {
    return { ok: false, reason: `computed non-positive size (${baseAmount})` };
  }

  return { ok: true, baseAmount, stakeQuote, clampedToMaxPosition };
}

/** Protective bracket prices derived from an entry and configured offsets. */
export interface BracketPrices {
  stopPrice: number;
  /** Limit price once the stop triggers (slightly through the trigger). */
  stopLimitPrice: number;
  takeProfitPrice: number;
}

export function computeBracket(
  entry: number,
  opts: { stopLossPct: number; stopLimitOffsetPct: number; takeProfitPct: number }
): BracketPrices {
  const stopPrice = entry * (1 - opts.stopLossPct);
  return {
    stopPrice,
    // Place the stop-limit a touch below the trigger so it fills on a drop.
    stopLimitPrice: stopPrice * (1 - opts.stopLimitOffsetPct),
    takeProfitPrice: entry * (1 + opts.takeProfitPct),
  };
}
