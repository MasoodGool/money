import { AlpacaVenue } from "./alpaca-venue.js";
import { buildApp } from "./app.js";
import { CcxtBinanceVenue } from "./binance-venue.js";
import { loadConfig } from "./config.js";
import { Executor } from "./executor.js";
import { SqliteJournal } from "./journal.js";
import { LogNotifier, type Notifier } from "./notifier.js";
import { captureException, initSentry } from "./sentry.js";
import { SqliteStore } from "./sqlite-store.js";
import { createTelegramTransport, TelegramNotifier } from "./telegram.js";
import { TelegramCommandListener } from "./telegram-commands.js";
import { ClaudeTweetAnalyzer } from "./tweets/analyzer.js";
import { DayTradeLedger } from "./tweets/day-trade-ledger.js";
import { AlpacaMarketGate, AlwaysOpenGate, type MarketGate } from "./tweets/market-gate.js";
import { TweetPoller } from "./tweets/poller.js";
import { TweetRouter } from "./tweets/router.js";
import { aliasesOf, buildEquitySymbolMap, buildSymbolMap } from "./tweets/symbols.js";
import { SqliteTweetLog } from "./tweets/tweet-log.js";
import { XApiTweetSource } from "./tweets/x-source.js";

const config = loadConfig();

// Is this venue in its fake-money mode? Alpaca paper / Binance testnet.
// Used for the Sentry environment, the Telegram status readout and the boot
// banner, so all three can never disagree about whether funds are real.
const fakeMoney = config.venue === "alpaca" ? config.alpaca.paper : config.binanceTestnet;
const venueLabel =
  config.venue === "alpaca"
    ? config.alpaca.paper
      ? "Alpaca PAPER"
      : "Alpaca LIVE (real funds)"
    : config.binanceTestnet
      ? "Binance TESTNET"
      : "Binance MAINNET (real funds)";

// Initialise Sentry before constructing or running anything it should watch.
// (None of the modules above do work at import time, so this is early enough.)
initSentry(config.sentryDsn, fakeMoney ? "paper" : "live");

// Venue selection. Equities (Alpaca) is the default because the followed
// account calls stocks; Binance stays available for a crypto-calling account.
const alpacaVenue =
  config.venue === "alpaca"
    ? new AlpacaVenue({
        apiKey: config.alpaca.apiKeyId,
        apiSecret: config.alpaca.apiSecretKey,
        paper: config.alpaca.paper,
      })
    : undefined;
const venue =
  alpacaVenue ??
  new CcxtBinanceVenue({
    apiKey: config.binanceApiKey,
    secret: config.binanceApiSecret,
    testnet: config.binanceTestnet,
  });

// Telegram when configured, otherwise log to stdout. A missing token must
// never silence alerts entirely — it degrades to the log.
const telegramConfigured = config.telegramBotToken !== "" && config.telegramChatId !== "";
const notifier: Notifier = telegramConfigured
  ? new TelegramNotifier({ botToken: config.telegramBotToken, chatId: config.telegramChatId })
  : new LogNotifier();

const store = new SqliteStore(config.stateDbPath);
const journal = new SqliteJournal(config.journalDbPath);

const executor = new Executor({
  venue,
  notifier,
  risk: config.risk,
  killSwitch: config.killSwitch,
  quoteCurrency: config.quoteCurrency,
  store,
  journal,
});

const app = buildApp({ executor });

app.log.info(
  { notifier: telegramConfigured ? "telegram" : "log" },
  telegramConfigured
    ? "Alerts → Telegram"
    : "Alerts → stdout log (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID for Telegram)"
);

// Two-way control: poll for /kill, /arm, /equity, /risk, /status. This is the
// remote safety panel — start it even when armed-off so the human can /arm.
if (telegramConfigured) {
  const listener = new TelegramCommandListener({
    transport: createTelegramTransport(config.telegramBotToken),
    chatId: config.telegramChatId,
    context: { executor, testnet: fakeMoney, quoteCurrency: config.quoteCurrency },
    log: (m) => app.log.warn(m),
  });
  listener.start();
  app.log.info("Telegram command listener started (/help for commands)");
}

// --- Tweet-driven signals (primary signal source) -------------------------
// Every new tweet from the followed account is classified and, when it is a
// clear call on an allowlisted asset, routed through the same risk gate as
// any other signal. Historical tweets are NOT traded here — the backfill is
// analysis-only (npm run backfill:tweets).
let tweetPoller: TweetPoller | undefined;
if (config.tweets.enabled) {
  const symbols =
    config.venue === "alpaca"
      ? buildEquitySymbolMap(config.tweets.assets)
      : buildSymbolMap(config.tweets.assets);
  // Equities close overnight and carry the pattern-day-trader rule; crypto
  // has neither, so that venue gets a gate that always says yes.
  const marketGate: MarketGate = alpacaVenue
    ? new AlpacaMarketGate({
        venue: alpacaVenue,
        ledger: new DayTradeLedger(store),
        dayTradeLimit: config.alpaca.dayTradeLimit,
        pdtEquityFloor: config.alpaca.pdtEquityFloor,
      })
    : new AlwaysOpenGate();
  const tweetLog = new SqliteTweetLog(config.tweets.tweetDbPath);
  const router = new TweetRouter({
    executor,
    analyzer: new ClaudeTweetAnalyzer({
      apiKey: config.tweets.anthropicApiKey,
      model: config.tweets.analystModel,
      aliases: aliasesOf(symbols),
    }),
    prices: venue,
    notifier,
    store,
    tweetLog,
    marketGate,
    config: {
      symbols,
      minConfidence: config.tweets.minConfidence,
      minConviction: config.tweets.minConviction,
      maxTweetAgeMinutes: config.tweets.maxTweetAgeMinutes,
      allowSpeculative: config.tweets.allowSpeculative,
      quoteCurrency: config.quoteCurrency,
    },
  });
  tweetPoller = new TweetPoller({
    source: new XApiTweetSource({
      handle: config.tweets.handle,
      bearerToken: config.tweets.xBearerToken,
    }),
    router,
    store,
    notifier,
    pollSeconds: config.tweets.pollSeconds,
    log: (m) => app.log.info(m),
  });
  app.log.info(
    {
      handle: config.tweets.handle,
      venue: config.venue,
      assets: config.tweets.assets,
      pollSeconds: config.tweets.pollSeconds,
      minConfidence: config.tweets.minConfidence,
    },
    `Tweet signals ON — following @${config.tweets.handle} on ${config.venue}`
  );
} else {
  app.log.warn(
    "Tweet signals OFF — set TWEET_HANDLE, X_BEARER_TOKEN and ANTHROPIC_API_KEY to enable"
  );
}

// Loud, unmissable banner about the execution mode this process booted in.
app.log.warn(
  {
    venue: config.venue,
    fakeMoney,
    killSwitch: config.killSwitch,
    equity: config.risk.equity,
  },
  config.killSwitch
    ? `Concierge starting: KILL SWITCH ON — notify-only, no orders will be placed (${venueLabel})`
    : `Concierge starting: AUTO-EXECUTION ARMED on ${venueLabel}`
);

// 0.0.0.0 is container-internal only; compose maps it to 127.0.0.1 on the
// host. No public ports — Hard Invariant 6.
app
  .listen({ port: config.port, host: "0.0.0.0" })
  .then(async () => {
    // Square persisted positions against the exchange before taking signals,
    // unless armed-off (no creds / kill switch may mean no venue access).
    if (!config.killSwitch) {
      try {
        await executor.reconcileOnBoot();
      } catch (err) {
        app.log.error(err, "boot reconciliation failed");
      }
    }
    // Start the tweet feed only after reconciliation, so a signal can't land
    // while the open-position view is still being squared. Priming the cursor
    // first means the account's existing backlog is never read as live calls.
    if (tweetPoller) {
      try {
        await tweetPoller.primeCursor();
        tweetPoller.start();
      } catch (err) {
        app.log.error(err, "tweet poller failed to start");
        await notifier
          .notify(`⚠️ Tweet feed failed to start: ${(err as Error).message}`)
          .catch(() => undefined);
      }
    }
  })
  .catch((err) => {
    app.log.error(err, "concierge failed to start");
    process.exit(1);
  });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    tweetPoller?.stop();
    await app.close();
    process.exit(0);
  });
}

// Last-resort capture so a crash on the money-moving path reaches Sentry.
process.on("unhandledRejection", (reason) => {
  app.log.error(reason, "unhandledRejection");
  captureException(reason);
});
process.on("uncaughtException", (err) => {
  app.log.error(err, "uncaughtException");
  captureException(err);
});
