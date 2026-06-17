import { buildApp } from "./app.js";
import { CcxtBinanceVenue } from "./binance-venue.js";
import { loadConfig } from "./config.js";
import { Executor } from "./executor.js";
import { LogNotifier, type Notifier } from "./notifier.js";
import { SqliteStore } from "./sqlite-store.js";
import { createTelegramTransport, TelegramNotifier } from "./telegram.js";
import { TelegramCommandListener } from "./telegram-commands.js";

const config = loadConfig();

const venue = new CcxtBinanceVenue({
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

const executor = new Executor({
  venue,
  notifier,
  risk: config.risk,
  killSwitch: config.killSwitch,
  store,
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
    context: { executor, testnet: config.binanceTestnet },
    log: (m) => app.log.warn(m),
  });
  listener.start();
  app.log.info("Telegram command listener started (/help for commands)");
}

// Loud, unmissable banner about the execution mode this process booted in.
app.log.warn(
  {
    binanceTestnet: config.binanceTestnet,
    killSwitch: config.killSwitch,
    equity: config.risk.equity,
  },
  config.killSwitch
    ? "Concierge starting: KILL SWITCH ON — notify-only, no orders will be placed"
    : config.binanceTestnet
      ? "Concierge starting: AUTO-EXECUTION ARMED on Binance TESTNET"
      : "Concierge starting: AUTO-EXECUTION ARMED on Binance MAINNET (real funds)"
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
  })
  .catch((err) => {
    app.log.error(err, "concierge failed to start");
    process.exit(1);
  });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.close();
    process.exit(0);
  });
}
