/**
 * Concierge runtime configuration, loaded from environment.
 *
 * AUTO-EXECUTION NOTE: as of the pivot to auto-execution, the Concierge —
 * not freqtrade — is what places real orders. freqtrade stays in dry-run and
 * only generates signals. The Binance key used here therefore needs TRADE
 * permission, but WITHDRAWAL MUST STAY DISABLED and the key must be
 * IP-restricted to this host. `binanceTestnet` defaults to true: real-money
 * mainnet is an explicit opt-in, gated behind strategy validation.
 */

import { DEFAULT_ASSETS } from "./tweets/symbols.js";

export interface RiskConfig {
  /** Account equity in quote currency (USDT). Updated out-of-band. */
  equity: number;
  /** Fraction of equity risked per trade (max loss to stop). 0.01 = 1%. */
  riskPerTrade: number;
  /** Hard cap on a single position as a fraction of equity. 0.20 = 20%. */
  maxPositionPct: number;
  /** Daily realized-loss limit as a fraction of equity. 0.03 = 3%. */
  dailyLossLimit: number;
  /** Distance from entry to the protective stop, as a fraction. 0.05 = 5%. */
  stopLossPct: number;
  /** Limit price offset below the stop trigger so the stop-limit fills. */
  stopLimitOffsetPct: number;
  /** Take-profit distance from entry, as a fraction. 0.08 = 8%. */
  takeProfitPct: number;
}

/**
 * Tweet-driven signal source. The account's timeline replaces freqtrade as
 * the primary signal generator: every new tweet is classified and, when it is
 * a clear call on an allowlisted asset, routed through the same risk gate.
 */
export interface TweetsConfig {
  /** Start the poller. Off unless a handle and both API keys are present. */
  enabled: boolean;
  /** Account to follow, without the leading @. */
  handle: string;
  xBearerToken: string;
  anthropicApiKey: string;
  /** Analyst model used to classify tweets. */
  analystModel: string;
  pollSeconds: number;
  /** Days of history the backfill script reads (analysis-only). */
  backfillDays: number;
  /** Minimum analyst confidence (0..1) before an entry may be placed. */
  minConfidence: number;
  minConviction: "low" | "medium" | "high";
  /** Reject calls older than this many minutes. */
  maxTweetAgeMinutes: number;
  /** Act on speculative/predictive tweets rather than firm calls. */
  allowSpeculative: boolean;
  /** Base assets we are willing to trade from a tweet. */
  assets: string[];
  /** Path to the tweet audit log SQLite file. */
  tweetDbPath: string;
}

export interface ConciergeConfig {
  port: number;
  binanceApiKey: string;
  binanceApiSecret: string;
  /** When true, orders go to the Binance spot TESTNET (fake balances). */
  binanceTestnet: boolean;
  /**
   * Master cut-off. When true, no orders are placed regardless of signals —
   * the Concierge degrades to notify-only. Defaults to true so a fresh/
   * misconfigured deploy never trades by accident.
   */
  killSwitch: boolean;
  /** Telegram bot token; when empty the Concierge logs instead of sending. */
  telegramBotToken: string;
  /** Telegram chat id alerts are sent to. */
  telegramChatId: string;
  /** Path to the SQLite file holding durable executor state. */
  stateDbPath: string;
  /** Path to the execution journal SQLite (feedback loop + SARS record). */
  journalDbPath: string;
  /** Sentry DSN; empty disables Sentry. */
  sentryDsn: string;
  risk: RiskConfig;
  tweets: TweetsConfig;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Env ${name} must be a finite number, got "${raw}"`);
  }
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function conviction(name: string, fallback: "low" | "medium" | "high") {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  return raw === "low" || raw === "medium" || raw === "high" ? raw : fallback;
}

function loadTweetsConfig(env: NodeJS.ProcessEnv): TweetsConfig {
  const handle = (env["TWEET_HANDLE"] ?? "TradexWhisperer").replace(/^@/, "").trim();
  const xBearerToken = env["X_BEARER_TOKEN"] ?? "";
  const anthropicApiKey = env["ANTHROPIC_API_KEY"] ?? "";
  const assets = (env["TWEET_ASSETS"] ?? DEFAULT_ASSETS.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return {
    // Requires both credentials: an X token with no analyst key (or vice
    // versa) is a half-wired feed, and a half-wired feed that silently does
    // nothing is worse than one that refuses to start.
    enabled:
      bool("TWEET_SIGNALS_ENABLED", true) &&
      handle !== "" &&
      xBearerToken !== "" &&
      anthropicApiKey !== "",
    handle,
    xBearerToken,
    anthropicApiKey,
    analystModel: env["TWEET_ANALYST_MODEL"] ?? "claude-opus-5",
    pollSeconds: num("TWEET_POLL_SECONDS", 60),
    backfillDays: num("TWEET_BACKFILL_DAYS", 30),
    minConfidence: num("TWEET_MIN_CONFIDENCE", 0.75),
    minConviction: conviction("TWEET_MIN_CONVICTION", "medium"),
    maxTweetAgeMinutes: num("TWEET_MAX_AGE_MINUTES", 30),
    allowSpeculative: bool("TWEET_ALLOW_SPECULATIVE", false),
    assets,
    tweetDbPath: env["TWEET_DB_PATH"] ?? "concierge-tweets.sqlite",
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConciergeConfig {
  return {
    port: num("PORT", 3000),
    binanceApiKey: env["BINANCE_API_KEY"] ?? "",
    binanceApiSecret: env["BINANCE_API_SECRET"] ?? "",
    // Mainnet is opt-in: only false when explicitly set falsey.
    binanceTestnet: bool("BINANCE_TESTNET", true),
    // Trading is opt-in: only armed when KILL_SWITCH is explicitly off.
    killSwitch: bool("KILL_SWITCH", true),
    telegramBotToken: env["TELEGRAM_BOT_TOKEN"] ?? "",
    telegramChatId: env["TELEGRAM_CHAT_ID"] ?? "",
    stateDbPath: env["STATE_DB_PATH"] ?? "concierge-state.sqlite",
    journalDbPath: env["JOURNAL_DB_PATH"] ?? "concierge-journal.sqlite",
    sentryDsn: env["SENTRY_DSN"] ?? "",
    risk: {
      equity: num("RISK_EQUITY", 1000),
      riskPerTrade: num("RISK_PER_TRADE", 0.01),
      maxPositionPct: num("RISK_MAX_POSITION_PCT", 0.2),
      dailyLossLimit: num("RISK_DAILY_LOSS_LIMIT", 0.03),
      stopLossPct: num("RISK_STOP_LOSS_PCT", 0.05),
      stopLimitOffsetPct: num("RISK_STOP_LIMIT_OFFSET_PCT", 0.005),
      takeProfitPct: num("RISK_TAKE_PROFIT_PCT", 0.08),
    },
    tweets: loadTweetsConfig(env),
  };
}
