# Testnet validation — the gate before real money

Auto-execution stays on **Binance spot testnet** until every check below is
green. The single most important one is that the **OCO bracket actually
rests on the book** — its wire format is the one piece that can't be verified
offline, and a position without a working stop is the worst failure mode.

## 1. Get a testnet key

1. Sign in at <https://testnet.binance.vision> (GitHub login).
2. Generate an **HMAC** API key. Testnet keys are sandboxed — no real funds —
   but still create it trade-enabled and **without withdrawal**, matching the
   mainnet posture you'll use later.
3. Fund the testnet account with the faucet (USDT + the base asset you'll test).

## 2. Run the automated drill

From `concierge/`, with egress to Binance:

```bash
BINANCE_API_KEY=<testnet key> \
BINANCE_API_SECRET=<testnet secret> \
BINANCE_TESTNET=1 \
VALIDATE_SYMBOL=BTC/USDT VALIDATE_NOTIONAL=20 \
npm run validate:testnet
```

It exercises the real `CcxtBinanceVenue`: fetch price → round to step size →
market buy → place OCO bracket → **confirm the bracket rests** → cancel →
flatten. Exit code 0 means all green. If the bracket check fails, the OCO
params in `binance-venue.ts::placeOcoSell` need adjustment for the current
ccxt/Binance API before going further.

## 3. End-to-end dry run with freqtrade

1. `docker compose up -d` with the testnet key in `.env`, `BINANCE_TESTNET=1`,
   and `KILL_SWITCH=0`.
2. Confirm the boot banner reads `AUTO-EXECUTION ARMED on Binance TESTNET`.
3. Let `BaselineTrend` (or a forced signal) fire and verify on the testnet UI:
   - the market buy filled at roughly the signalled price;
   - a resting OCO sell bracket exists at the expected stop/TP;
   - the Telegram alert (or log) matches what happened.
4. Trigger an exit and confirm the bracket is cancelled and the position
   flattened.
5. Restart the Concierge mid-position and confirm `reconcileOnBoot` keeps the
   still-open position and drops one whose bracket you manually fill on testnet.
6. From Telegram: `/status`, `/risk`, `/kill` (verify entries are suppressed),
   `/arm`.

## 4. Sign-off checklist

- [ ] `npm run validate:testnet` exits 0
- [ ] OCO bracket confirmed resting on the testnet order book
- [ ] step-size / min-notional rounding produces valid orders
- [ ] entry → bracket → exit observed end to end via freqtrade
- [ ] restart reconciliation behaves correctly
- [ ] `/kill` from Telegram suppresses entries; `/arm` resumes
- [ ] strategy has cleared the Phase 1 graduation bar on out-of-sample data

Only when **all** boxes are ticked is `BINANCE_TESTNET=0` (real funds) a
defensible change — and even then, start with reduced equity.
