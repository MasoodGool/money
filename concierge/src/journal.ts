/**
 * Execution journal — the record of what the bot actually did, and the basis
 * for the feedback loop (slippage, paper-vs-real, and the SARS record, since
 * frequent-trading profits are revenue in South Africa).
 *
 * The executor writes a row for every entry, exit, and skip. The nightly
 * Binance trade-history sync reconciles rows against real fills.
 */

import { DatabaseSync } from "node:sqlite";

export interface JournalRecord {
  ts: string; // ISO timestamp
  tradeId: string;
  symbol: string;
  kind: "entry" | "exit" | "skip";
  status: string; // placed | closed | skipped
  signalPrice: number | null; // intended price from the signal
  fillPrice: number | null; // venue-reported fill
  amount: number | null;
  stakeQuote: number | null;
  realizedQuote: number | null; // exits only
  reason: string | null; // skip reason / context
}

export interface JournalRow extends JournalRecord {
  id: number;
  realFillPrice: number | null; // from the nightly Binance sync
  reconciled: number; // 0/1
}

export interface Journal {
  record(r: JournalRecord): void;
}

/** No-op for tests / runs without a journal configured. */
export class NoopJournal implements Journal {
  record(): void {}
}

export class SqliteJournal implements Journal {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS journal (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        ts             TEXT NOT NULL,
        trade_id       TEXT NOT NULL,
        symbol         TEXT NOT NULL,
        kind           TEXT NOT NULL,
        status         TEXT NOT NULL,
        signal_price   REAL,
        fill_price     REAL,
        amount         REAL,
        stake_quote    REAL,
        realized_quote REAL,
        reason         TEXT,
        real_fill_price REAL,
        reconciled     INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_journal_ts ON journal(ts);
    `);
  }

  record(r: JournalRecord): void {
    this.db
      .prepare(
        `INSERT INTO journal
          (ts, trade_id, symbol, kind, status, signal_price, fill_price,
           amount, stake_quote, realized_quote, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        r.ts,
        r.tradeId,
        r.symbol,
        r.kind,
        r.status,
        r.signalPrice,
        r.fillPrice,
        r.amount,
        r.stakeQuote,
        r.realizedQuote,
        r.reason
      );
  }

  since(tsIso: string): JournalRow[] {
    return this.mapRows(
      this.db.prepare("SELECT * FROM journal WHERE ts >= ? ORDER BY ts").all(tsIso)
    );
  }

  all(): JournalRow[] {
    return this.mapRows(this.db.prepare("SELECT * FROM journal ORDER BY ts").all());
  }

  /** Filled rows not yet matched to a real Binance trade. */
  unreconciledFills(): JournalRow[] {
    return this.mapRows(
      this.db
        .prepare(
          "SELECT * FROM journal WHERE reconciled = 0 AND fill_price IS NOT NULL ORDER BY ts"
        )
        .all()
    );
  }

  markReconciled(id: number, realFillPrice: number): void {
    this.db
      .prepare("UPDATE journal SET reconciled = 1, real_fill_price = ? WHERE id = ?")
      .run(realFillPrice, id);
  }

  private mapRows(rows: unknown[]): JournalRow[] {
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      id: Number(r["id"]),
      ts: String(r["ts"]),
      tradeId: String(r["trade_id"]),
      symbol: String(r["symbol"]),
      kind: r["kind"] as JournalRow["kind"],
      status: String(r["status"]),
      signalPrice: r["signal_price"] as number | null,
      fillPrice: r["fill_price"] as number | null,
      amount: r["amount"] as number | null,
      stakeQuote: r["stake_quote"] as number | null,
      realizedQuote: r["realized_quote"] as number | null,
      reason: r["reason"] as string | null,
      realFillPrice: r["real_fill_price"] as number | null,
      reconciled: Number(r["reconciled"]),
    }));
  }
}
