import { buildApp } from "./app.js";
import { CcxtBinanceVenue } from "./binance-venue.js";
import { loadConfig } from "./config.js";
import { Executor } from "./executor.js";
import { LogNotifier } from "./notifier.js";

const config = loadConfig();

const venue = new CcxtBinanceVenue({
  apiKey: config.binanceApiKey,
  secret: config.binanceApiSecret,
  testnet: config.binanceTestnet,
});

const executor = new Executor({
  venue,
  notifier: new LogNotifier(),
  risk: config.risk,
  killSwitch: config.killSwitch,
});

const app = buildApp({ executor });

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
app.listen({ port: config.port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err, "concierge failed to start");
  process.exit(1);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.close();
    process.exit(0);
  });
}
