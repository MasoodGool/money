import { describe, expect, it } from "vitest";

import { computeBracket, computePositionSize } from "../src/risk.js";

describe("computePositionSize — 1% rule", () => {
  it("sizes from equity, risk fraction, and stop distance", () => {
    // 1% of 10000 = 100 risk; stop distance 142.30 - 135.19 = 7.11
    const r = computePositionSize({
      equity: 10000,
      riskPerTrade: 0.01,
      maxPositionPct: 0.5, // high cap so the 1% rule is what binds
      entry: 142.3,
      stopPrice: 135.19,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.baseAmount).toBeCloseTo(100 / 7.11, 6);
    expect(r.stakeQuote).toBeCloseTo((100 / 7.11) * 142.3, 4);
    expect(r.clampedToMaxPosition).toBe(false);
  });

  it("clamps a tight-stop position to the max-position cap", () => {
    // Very tight stop => huge 1% size; cap at 20% of equity.
    const r = computePositionSize({
      equity: 10000,
      riskPerTrade: 0.01,
      maxPositionPct: 0.2,
      entry: 100,
      stopPrice: 99.9, // 0.1 distance => 1000 base before clamp = 100000 notional
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.clampedToMaxPosition).toBe(true);
    expect(r.stakeQuote).toBeCloseTo(2000, 6); // 20% of 10000
    expect(r.baseAmount).toBeCloseTo(20, 6);
  });

  it("rejects a stop at or above entry (non-positive risk distance)", () => {
    expect(computePositionSize({
      equity: 10000, riskPerTrade: 0.01, maxPositionPct: 0.2, entry: 100, stopPrice: 100,
    }).ok).toBe(false);
    expect(computePositionSize({
      equity: 10000, riskPerTrade: 0.01, maxPositionPct: 0.2, entry: 100, stopPrice: 105,
    }).ok).toBe(false);
  });

  it("rejects non-positive equity and entry", () => {
    expect(computePositionSize({
      equity: 0, riskPerTrade: 0.01, maxPositionPct: 0.2, entry: 100, stopPrice: 95,
    }).ok).toBe(false);
    expect(computePositionSize({
      equity: 10000, riskPerTrade: 0.01, maxPositionPct: 0.2, entry: 0, stopPrice: -1,
    }).ok).toBe(false);
  });
});

describe("computeBracket", () => {
  it("derives stop, stop-limit, and take-profit from offsets", () => {
    const b = computeBracket(100, {
      stopLossPct: 0.05,
      stopLimitOffsetPct: 0.005,
      takeProfitPct: 0.08,
    });
    expect(b.stopPrice).toBeCloseTo(95, 6);
    expect(b.stopLimitPrice).toBeCloseTo(95 * 0.995, 6);
    expect(b.takeProfitPrice).toBeCloseTo(108, 6);
    // Stop-limit sits below the trigger so it fills on a falling market.
    expect(b.stopLimitPrice).toBeLessThan(b.stopPrice);
  });
});
