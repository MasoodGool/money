/**
 * Feedback-loop analytics over journal rows. Pure functions so the maths is
 * unit-tested; the weekly-report script just formats the output.
 *
 * Slippage is signal price vs actual fill, in basis points. For an entry
 * (buy) a positive value means we paid MORE than the signalled price —
 * adverse. If real slippage consistently exceeds the 0.03% backtest
 * assumption, bump it and re-run the Phase 1 validation.
 */

import type { JournalRow } from "./journal.js";

export interface SlippageStats {
  count: number;
  meanBps: number;
  medianBps: number;
  p90Bps: number;
  maxBps: number;
}

export interface ReportSummary {
  entries: number;
  exits: number;
  skips: number;
  realizedQuote: number;
  wins: number;
  losses: number;
  entrySlippage: SlippageStats;
  skipReasons: Record<string, number>;
  unreconciledFills: number;
  /** Paper P&L from freqtrade for the same window, if available. */
  paperRealizedQuote: number | undefined;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

function slippageBps(rows: JournalRow[]): SlippageStats {
  const bps = rows
    .filter((r) => r.kind === "entry" && r.signalPrice && r.fillPrice)
    .map((r) => ((r.fillPrice! - r.signalPrice!) / r.signalPrice!) * 10000);
  if (bps.length === 0) {
    return { count: 0, meanBps: 0, medianBps: 0, p90Bps: 0, maxBps: 0 };
  }
  const sorted = [...bps].sort((a, b) => a - b);
  const mean = bps.reduce((a, b) => a + b, 0) / bps.length;
  return {
    count: bps.length,
    meanBps: mean,
    medianBps: percentile(sorted, 50),
    p90Bps: percentile(sorted, 90),
    maxBps: sorted[sorted.length - 1]!,
  };
}

export function summarize(rows: JournalRow[], paperRealizedQuote?: number): ReportSummary {
  const exits = rows.filter((r) => r.kind === "exit");
  const skips = rows.filter((r) => r.kind === "skip");
  const skipReasons: Record<string, number> = {};
  for (const s of skips) {
    const key = (s.reason ?? "unknown").split(" (")[0]!.split(":")[0]!;
    skipReasons[key] = (skipReasons[key] ?? 0) + 1;
  }
  return {
    entries: rows.filter((r) => r.kind === "entry").length,
    exits: exits.length,
    skips: skips.length,
    realizedQuote: exits.reduce((a, r) => a + (r.realizedQuote ?? 0), 0),
    wins: exits.filter((r) => (r.realizedQuote ?? 0) > 0).length,
    losses: exits.filter((r) => (r.realizedQuote ?? 0) < 0).length,
    entrySlippage: slippageBps(rows),
    skipReasons,
    unreconciledFills: rows.filter((r) => r.fillPrice !== null && r.reconciled === 0).length,
    paperRealizedQuote,
  };
}

export function formatReport(s: ReportSummary, fromIso: string, toIso: string): string {
  const lines = [
    `📊 Weekly report  ${fromIso.slice(0, 10)} → ${toIso.slice(0, 10)}`,
    ``,
    `Entries: ${s.entries}  Exits: ${s.exits}  Skips: ${s.skips}`,
    `Realized (real): ${s.realizedQuote >= 0 ? "+" : ""}${s.realizedQuote.toFixed(2)} USDT  ` +
      `(${s.wins}W / ${s.losses}L)`,
  ];
  if (s.paperRealizedQuote !== undefined) {
    const gap = s.realizedQuote - s.paperRealizedQuote;
    lines.push(
      `Realized (paper): ${s.paperRealizedQuote >= 0 ? "+" : ""}${s.paperRealizedQuote.toFixed(2)} USDT  ` +
        `| real−paper gap: ${gap >= 0 ? "+" : ""}${gap.toFixed(2)}`
    );
  }
  lines.push(
    ``,
    `Entry slippage (bps): n=${s.entrySlippage.count}  ` +
      `mean ${s.entrySlippage.meanBps.toFixed(1)}  median ${s.entrySlippage.medianBps.toFixed(1)}  ` +
      `p90 ${s.entrySlippage.p90Bps.toFixed(1)}  max ${s.entrySlippage.maxBps.toFixed(1)}`,
    `(backtest assumption is 3.0 bps / 0.03% — revisit if mean drifts above it)`,
    ``,
    `Skips: ${Object.entries(s.skipReasons).map(([k, v]) => `${k}×${v}`).join(", ") || "none"}`,
    `Unreconciled fills: ${s.unreconciledFills}`,
  );
  return lines.join("\n");
}
