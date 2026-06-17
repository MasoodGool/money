/**
 * Export the execution journal to CSV — doubles as the SARS record
 * (frequent-trading profits are revenue in South Africa; keep it clean).
 *
 *   JOURNAL_DB_PATH=/data/journal.sqlite npx tsx scripts/export-csv.ts > journal.csv
 */

import { SqliteJournal } from "../src/journal.js";

const journalPath = process.env["JOURNAL_DB_PATH"] ?? "concierge-journal.sqlite";

const COLS: Array<keyof import("../src/journal.js").JournalRow> = [
  "id",
  "ts",
  "tradeId",
  "symbol",
  "kind",
  "status",
  "signalPrice",
  "fillPrice",
  "realFillPrice",
  "amount",
  "stakeQuote",
  "realizedQuote",
  "reconciled",
  "reason",
];

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const journal = new SqliteJournal(journalPath);
const rows = journal.all();
process.stdout.write(COLS.join(",") + "\n");
for (const row of rows) {
  process.stdout.write(COLS.map((c) => csvCell(row[c])).join(",") + "\n");
}
