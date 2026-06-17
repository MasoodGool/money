/**
 * Nightly Binance trade-history sync. Reconciles journal fills against the
 * exchange's record of truth (myTrades) so the weekly slippage/P&L figures
 * rest on real fills, and unmatched fills/tickets get flagged.
 *
 *   BINANCE_API_KEY=... BINANCE_API_SECRET=... BINANCE_TESTNET=1 \
 *   JOURNAL_DB_PATH=/data/journal.sqlite npx tsx scripts/sync-trades.ts
 *
 * Cron (on the VM): 30 2 * * *  cd ~/signal-engine/concierge && npx tsx scripts/sync-trades.ts
 *
 * Read-only against trades: uses fetchMyTrades only — it never places orders.
 */

import ccxt from "ccxt";

import { loadConfig } from "../src/config.js";
import { SqliteJournal } from "../src/journal.js";

const cfg = loadConfig();
const journalPath = process.env["JOURNAL_DB_PATH"] ?? "concierge-journal.sqlite";
const PAIRS = (process.env["SYNC_PAIRS"] ?? "BTC/USDT,ETH/USDT,SOL/USDT")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);
// Match window: a real fill within this many ms of the journalled fill, same
// pair, and amount within tolerance, is considered the same trade.
const WINDOW_MS = Number(process.env["SYNC_WINDOW_MS"] ?? 10 * 60 * 1000);
const AMOUNT_TOL = Number(process.env["SYNC_AMOUNT_TOL"] ?? 0.02); // 2%

async function main(): Promise<void> {
  if (!cfg.binanceApiKey || !cfg.binanceApiSecret) {
    console.error("Set BINANCE_API_KEY / BINANCE_API_SECRET (read access is enough).");
    process.exit(2);
  }
  const ex = new ccxt.binance({
    apiKey: cfg.binanceApiKey,
    secret: cfg.binanceApiSecret,
    options: { defaultType: "spot" },
  });
  if (cfg.binanceTestnet) ex.setSandboxMode(true);

  const journal = new SqliteJournal(journalPath);
  const pending = journal.unreconciledFills();
  if (pending.length === 0) {
    console.log("Nothing to reconcile.");
    return;
  }

  // Fetch recent real trades per pair once.
  const since = Math.min(...pending.map((p) => Date.parse(p.ts))) - WINDOW_MS;
  const realByPair = new Map<string, Array<{ ts: number; price: number; amount: number }>>();
  for (const pair of PAIRS) {
    try {
      const trades = await ex.fetchMyTrades(pair, since);
      realByPair.set(
        pair,
        trades.map((t) => ({ ts: t.timestamp ?? 0, price: Number(t.price), amount: Number(t.amount) }))
      );
    } catch (err) {
      console.error(`fetchMyTrades ${pair} failed: ${(err as Error).message}`);
    }
  }

  let matched = 0;
  for (const row of pending) {
    const candidates = realByPair.get(row.symbol) ?? [];
    const jTs = Date.parse(row.ts);
    const hit = candidates.find(
      (t) =>
        Math.abs(t.ts - jTs) <= WINDOW_MS &&
        row.amount !== null &&
        Math.abs(t.amount - row.amount) <= Math.abs(row.amount) * AMOUNT_TOL
    );
    if (hit) {
      journal.markReconciled(row.id, hit.price);
      matched++;
    } else {
      console.warn(`UNMATCHED journal fill #${row.tradeId} ${row.symbol} @ ${row.ts}`);
    }
  }
  console.log(`Reconciled ${matched}/${pending.length} fills; ${pending.length - matched} unmatched.`);
}

void main();
