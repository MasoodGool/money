/**
 * Weekly report (intended for Sunday 18:00 SAST via cron). Reads the journal,
 * computes real P&L / slippage / skip analysis, optionally compares against
 * freqtrade's paper P&L, prints it, and sends it to Telegram if configured.
 *
 *   JOURNAL_DB_PATH=/data/journal.sqlite npx tsx scripts/weekly-report.ts
 *
 * Cron (on the VM):
 *   0 18 * * 0  cd ~/signal-engine/concierge && npx tsx scripts/weekly-report.ts
 */

import { DatabaseSync } from "node:sqlite";

import { loadConfig } from "../src/config.js";
import { SqliteJournal } from "../src/journal.js";
import { formatReport, summarize } from "../src/report.js";

const cfg = loadConfig();
const journalPath = process.env["JOURNAL_DB_PATH"] ?? "concierge-journal.sqlite";
const ftDbPath = process.env["FREQTRADE_DB_PATH"]; // optional paper baseline

const to = new Date();
const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);

/** Best-effort paper P&L from freqtrade's own SQLite for the same window. */
function paperRealized(): number | undefined {
  if (!ftDbPath) return undefined;
  try {
    const db = new DatabaseSync(ftDbPath, { readOnly: true });
    const row = db
      .prepare(
        "SELECT COALESCE(SUM(close_profit_abs), 0) AS pnl FROM trades " +
          "WHERE is_open = 0 AND close_date >= ?"
      )
      .get(from.toISOString()) as { pnl: number } | undefined;
    db.close();
    return row ? Number(row.pnl) : undefined;
  } catch {
    return undefined; // schema/path mismatch — skip the paper line gracefully
  }
}

async function sendTelegram(text: string): Promise<void> {
  if (!cfg.telegramBotToken || !cfg.telegramChatId) return;
  await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: cfg.telegramChatId, text }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => undefined);
}

async function main(): Promise<void> {
  const journal = new SqliteJournal(journalPath);
  const rows = journal.since(from.toISOString());
  const summary = summarize(rows, paperRealized());
  const report = formatReport(summary, from.toISOString(), to.toISOString());
  console.log(report);
  await sendTelegram(report);
}

void main();
