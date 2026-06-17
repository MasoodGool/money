/**
 * Live testnet validation of the execution path. Run on a machine/session
 * with Binance egress and a SPOT TESTNET key:
 *
 *   BINANCE_API_KEY=... BINANCE_API_SECRET=... BINANCE_TESTNET=1 \
 *     npx tsx scripts/validate-testnet.ts
 *
 * It exercises the REAL CcxtBinanceVenue methods end to end and, above all,
 * confirms the OCO bracket actually rests on the book — the one piece whose
 * wire format couldn't be verified offline. A tiny notional is used and the
 * position is flattened at the end. Refuses to touch mainnet unless
 * FORCE_MAINNET_VALIDATION=1 is set (don't).
 */

import ccxt from "ccxt";

import { CcxtBinanceVenue } from "../src/binance-venue.js";
import { loadConfig } from "../src/config.js";
import { computeBracket } from "../src/risk.js";

const cfg = loadConfig();
const SYMBOL = process.env["VALIDATE_SYMBOL"] ?? "BTC/USDT";
const NOTIONAL = Number(process.env["VALIDATE_NOTIONAL"] ?? "20");

let failures = 0;
async function step<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  process.stdout.write(`• ${label} … `);
  try {
    const result = await fn();
    console.log("OK");
    return result;
  } catch (err) {
    failures++;
    console.log(`FAIL — ${(err as Error).message}`);
    return undefined;
  }
}

async function main(): Promise<void> {
  if (!cfg.binanceTestnet && process.env["FORCE_MAINNET_VALIDATION"] !== "1") {
    console.error("Refusing to run: BINANCE_TESTNET is off. This is a testnet drill.");
    process.exit(2);
  }
  if (!cfg.binanceApiKey || !cfg.binanceApiSecret) {
    console.error("Set BINANCE_API_KEY and BINANCE_API_SECRET (testnet key).");
    process.exit(2);
  }

  console.log(`\nTestnet validation: ${SYMBOL}, ~${NOTIONAL} USDT notional\n`);
  const venue = new CcxtBinanceVenue({
    apiKey: cfg.binanceApiKey,
    secret: cfg.binanceApiSecret,
    testnet: cfg.binanceTestnet,
  });

  // Independent ccxt client just for the current price.
  const px = new ccxt.binance({
    apiKey: cfg.binanceApiKey,
    secret: cfg.binanceApiSecret,
    options: { defaultType: "spot" },
  });
  if (cfg.binanceTestnet) px.setSandboxMode(true);

  const price = await step("fetch price", async () => {
    const t = await px.fetchTicker(SYMBOL);
    const last = t.last;
    if (!last) throw new Error("no last price");
    return last;
  });
  if (price === undefined) return finish();

  await step("load filters", () => venue.getFilters(SYMBOL));
  const amount = await step("round amount to step size", () =>
    venue.roundAmount(SYMBOL, NOTIONAL / price)
  );
  if (!amount) return finish();

  const buy = await step("market buy", () => venue.marketBuy(SYMBOL, amount));
  if (!buy) return finish();

  const raw = computeBracket(price, {
    stopLossPct: cfg.risk.stopLossPct,
    stopLimitOffsetPct: cfg.risk.stopLimitOffsetPct,
    takeProfitPct: cfg.risk.takeProfitPct,
  });
  const bracket = {
    takeProfitPrice: await venue.roundPrice(SYMBOL, raw.takeProfitPrice),
    stopPrice: await venue.roundPrice(SYMBOL, raw.stopPrice),
    stopLimitPrice: await venue.roundPrice(SYMBOL, raw.stopLimitPrice),
  };

  const oco = await step("place OCO stop/TP bracket", () =>
    venue.placeOcoSell(SYMBOL, buy.amount, bracket)
  );

  if (oco) {
    await step("⭑ confirm bracket RESTS on the book", async () => {
      const open = await venue.isOrderOpen(SYMBOL, oco.id);
      if (!open) throw new Error("OCO is not open — bracket did not rest!");
    });
    await step("cancel the bracket", () => venue.cancelOrder(SYMBOL, oco.id));
  }

  // Flatten whatever we bought so the drill leaves no position behind.
  await step("flatten position (market sell)", () => venue.marketSell(SYMBOL, buy.amount));

  finish();
}

function finish(): void {
  console.log(
    failures === 0
      ? "\n✅ ALL CHECKS PASSED — the execution path works against testnet.\n"
      : `\n❌ ${failures} check(s) FAILED — do NOT flip to mainnet until green.\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
