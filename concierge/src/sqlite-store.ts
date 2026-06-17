/**
 * SQLite-backed StateStore using Node's built-in node:sqlite (no native
 * build step — important for the alpine container). Synchronous API, which
 * suits write-through persistence on a single-instance service.
 */

import { DatabaseSync } from "node:sqlite";

import type { DailyState, OpenPosition, StateStore } from "./store.js";

export class SqliteStore implements StateStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS positions (
        trade_id    TEXT PRIMARY KEY,
        symbol      TEXT NOT NULL,
        amount      REAL NOT NULL,
        entry_price REAL NOT NULL,
        stop_price  REAL NOT NULL,
        oco_order_id TEXT
      );
      CREATE TABLE IF NOT EXISTS handled_entries (trade_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  loadPositions(): OpenPosition[] {
    const rows = this.db.prepare("SELECT * FROM positions").all() as Array<{
      trade_id: string;
      symbol: string;
      amount: number;
      entry_price: number;
      stop_price: number;
      oco_order_id: string | null;
    }>;
    return rows.map((r) => ({
      tradeId: r.trade_id,
      symbol: r.symbol,
      amount: r.amount,
      entryPrice: r.entry_price,
      stopPrice: r.stop_price,
      ocoOrderId: r.oco_order_id ?? undefined,
    }));
  }

  savePosition(p: OpenPosition): void {
    this.db
      .prepare(
        `INSERT INTO positions (trade_id, symbol, amount, entry_price, stop_price, oco_order_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(trade_id) DO UPDATE SET
           symbol=excluded.symbol, amount=excluded.amount,
           entry_price=excluded.entry_price, stop_price=excluded.stop_price,
           oco_order_id=excluded.oco_order_id`
      )
      .run(p.tradeId, p.symbol, p.amount, p.entryPrice, p.stopPrice, p.ocoOrderId ?? null);
  }

  deletePosition(tradeId: string): void {
    this.db.prepare("DELETE FROM positions WHERE trade_id = ?").run(tradeId);
  }

  isHandled(tradeId: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM handled_entries WHERE trade_id = ?").get(tradeId) !==
      undefined
    );
  }

  markHandled(tradeId: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO handled_entries (trade_id) VALUES (?)")
      .run(tradeId);
  }

  getDaily(): DailyState | undefined {
    const key = this.getSetting("daily_key");
    const loss = this.getSetting("daily_loss");
    if (key === undefined || loss === undefined) return undefined;
    return { dayKey: key, lossQuote: Number(loss) };
  }

  setDaily(state: DailyState): void {
    this.setSetting("daily_key", state.dayKey);
    this.setSetting("daily_loss", String(state.lossQuote));
  }

  getSetting(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      )
      .run(key, value);
  }
}
