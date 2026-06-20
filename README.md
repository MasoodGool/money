# signal-engine

A signal generation and **auto-execution** system built on
[freqtrade](https://www.freqtrade.io/). freqtrade runs permanently in dry-run
as the *signal generator only*; the **Concierge** is what places real orders
on Binance — autonomously, with risk sizing and circuit breakers in front of
every order. (This project began as a manual human-gated design; see
[Auto-execution pivot](#auto-execution-pivot) for what changed and why.)

## Hard Invariants

These are non-negotiable. Treat any change that violates one as a bug.

1. **freqtrade stays `dry_run: true`.** It never executes — it only emits
   signals. All real order placement lives in the Concierge, which keeps
   freqtrade's paper P&L an honest baseline to measure execution against.
2. **The Binance key has TRADE permission but NEVER withdrawal.** Withdrawal
   stays disabled, always. The key is IP-restricted to the deployment host.
   Use a **testnet** key while `BINANCE_TESTNET=1`; a mainnet key is only
   swapped in after a strategy clears the Phase 1 graduation bar.
3. **Out-of-sample backtest data is touched once per strategy version.**
   No re-tuning against it.
4. **Every order passes the risk gate first:** size from the 1% rule, capped
   at the max-position %, step-size-rounded, min-notional-checked, and a
   resting OCO stop/TP bracket placed so an open position is always protected.
5. **A signal is never silently dropped** — every webhook is acknowledged and
   either executed or notified with a reason.
6. **No public ports except SSH.** FreqUI via SSH tunnel/Tailscale only. The
   Concierge binds to loopback only.

Two software cut-offs back these up: `KILL_SWITCH=1` (default) makes the
Concierge notify-only, and `BINANCE_TESTNET=1` (default) keeps orders off
real funds. A fresh or misconfigured deploy therefore trades nothing.

## Auto-execution pivot

The original design routed every signal to a Telegram ticket that a human
executed by hand. That has been replaced by **fully autonomous execution in
the Concierge**, decided deliberately:

- **freqtrade executes?** No — the Concierge does. freqtrade stays dry-run, so
  paper vs. real comparison (Phase 5) still works.
- **Human confirmation?** None. Telegram becomes notify-only.
- **Where do orders go?** Binance **spot testnet** first; mainnet is a
  one-flag change (`BINANCE_TESTNET=0`) gated on strategy validation.

The trade-offs (no human catch for look-ahead bugs / stale prices / flash
crashes; a trade-permission key's larger blast radius; trading a baseline that
is *allowed to lose* until it clears the graduation bar) are accepted and
mitigated by the risk gate, the kill switch, and testnet-first.

## Architecture

```
Binance market data ──→ freqtrade (dry-run, Python)   ← signal generator only
                            │ entry/exit webhook
                            ▼
                     Concierge (TypeScript)
                       ├─ risk gate: 1% sizing + max-position clamp
                       ├─ kill switch + daily-loss circuit breaker
                       ├─ idempotency (one order per trade_id)
                       └─ ccxt → Binance (testnet→mainnet)
                            │ market buy + resting OCO stop/TP bracket
                            ▼
                     Binance spot account        Telegram (notify-only)
                            │
                            ▼  nightly trade-history sync → journal SQLite
```

- **freqtrade** (Python) owns strategies, dry-run paper trading, and
  backtesting. It emits entry/exit webhooks and never touches the exchange to
  trade. Its native Telegram (Phase 2) sends daily summaries / health only.
- **Concierge** (TypeScript, Node 22, Fastify) is the execution engine:
  receives the webhook, sizes the position, places the order and its
  protective bracket via ccxt, and notifies Telegram after the fact. The
  exchange-specific code is isolated in `binance-venue.ts` behind an
  `ExecutionVenue` interface so the risk/decision logic is unit-tested
  without network access.

## Repo layout

```
├── docker-compose.yml          # freqtrade (pinned image) + concierge
├── .env.example                # template; never commit .env
├── bot/
│   └── user_data/
│       ├── strategies/         # freqtrade strategies (Python)
│       ├── config/
│       │   ├── config.dryrun.json    # dry_run: true — permanent invariant
│       │   └── config.backtest.json  # offline runs, no side effects
│       ├── data/               # downloaded OHLCV (gitignored)
│       ├── db/                 # freqtrade SQLite state (gitignored)
│       └── notebooks/
├── concierge/                  # TypeScript execution engine (Fastify, ccxt)
│   ├── src/
│   │   ├── risk.ts             # 1% sizing + clamps (pure)
│   │   ├── executor.ts         # guards → place order + OCO bracket
│   │   ├── venue.ts            # ExecutionVenue interface
│   │   ├── binance-venue.ts    # ccxt Binance adapter (testnet-aware)
│   │   └── app.ts / index.ts   # Fastify wiring
│   └── test/                   # vitest (risk, executor, routing)
├── scripts/
│   ├── download-data.sh        # 2y of 1h/4h/1d for the whitelist
│   └── simulate-webhook.sh     # POST a fake entry signal at the Concierge
└── tests/                      # pytest (bot) — arrives in Phase 1
```

## Quickstart

```bash
cp .env.example .env            # chmod 600; leave KILL_SWITCH=1 / BINANCE_TESTNET=1
docker compose up -d            # freqtrade dry-run + concierge

# Watch signals arrive in the Concierge log
docker compose logs -f concierge

# Simulate a freqtrade entry webhook (skipped while KILL_SWITCH=1)
./scripts/simulate-webhook.sh

# Download 2 years of candles for backtesting
./scripts/download-data.sh
```

**Arming auto-execution (testnet):** create a spot-testnet key at
<https://testnet.binance.vision> with trading enabled, put it in `.env`, set
`KILL_SWITCH=0`, and restart the Concierge. It boots logging
`AUTO-EXECUTION ARMED on Binance TESTNET`. Validate a few round-trips —
**especially that the OCO bracket actually rests on the book** (the one
ccxt/Binance detail to confirm live) — before ever setting
`BINANCE_TESTNET=0` for real funds.

The freqtrade container runs as uid 1000 (`ftuser`); if `bot/user_data` is
owned by another user, `chown -R 1000:1000 bot/user_data` so it can write
its SQLite state and downloaded data.

Concierge development:

```bash
cd concierge
npm install
npm test          # vitest
npm run dev       # local server with reload
```

## Phase status

- [x] **Phase 0 — Scaffold & local dev**: compose runs freqtrade (pinned
  `2025.12`, dry-run, BTC/ETH/SOL whitelist) + Concierge skeleton
  (`/signal` + `/healthz`, payload logging only); webhook plumbing verified;
  data download script in place. The Phase 0 strategy (`NoopScaffold`) never
  signals — it exists only to boot the pipeline.
- [x] **Phase 1 — Baseline strategy + backtesting discipline**: `BaselineTrend`
  (EMA20/50 cross + RSI + volume, 4h), no look-ahead (closed candles +
  qtpylib crosses); deterministic signal tests; `scripts/backtest.sh` runs
  in-sample (tune) vs out-of-sample (touch once) with fee+slippage. **V1
  FAILED the graduation bar** — it lost in both a +58% bull (in-sample) and a
  −41% bear (out-of-sample); backwards risk/reward (ROI-capped small winners,
  bigger losers). Out-of-sample is now spent for V1.
- [~] **`BaselineTrendV2`** (in-sample tuning candidate): three structural
  fixes for V1's failure — a **daily-trend regime filter** (only long while
  price > 1d EMA50), a **trailing stop** so winners run instead of being
  ROI-capped, and a **12-pair universe** for ≥30-trade significance. Default
  strategy in the configs and `backtest.sh`. Signal logic unit-tested; awaits
  a walk-forward run. ⚠️ **Live-execution note:** V2's edge is the trailing
  stop, which freqtrade manages and surfaces as an exit webhook — but the
  Concierge currently places a *fixed* TP leg that would cap winners early.
  If V2 graduates, the Concierge bracket must become stop-only (or far-TP) and
  let freqtrade's exit drive the close. Backtest first; this is a pre-mainnet
  fix, moot until V2 earns it.
- [x] **Auto-execution engine** (replaces the manual Telegram-ticket plan):
  Concierge sizes (1% rule + 20% clamp), guards (kill switch, 3% daily-loss
  breaker, per-`trade_id` idempotency, step-size + min-notional), and places a
  market entry + resting OCO stop/TP bracket via ccxt. Exchange code isolated
  behind `ExecutionVenue`; the live ccxt OCO path is validated by the testnet
  drill before any mainnet flip.
- [x] **Durable state + boot reconciliation**: `node:sqlite` persists open
  positions, idempotency, daily tally, equity, kill switch; on boot,
  positions whose bracket no longer rests are reconciled (TP/SL filled while
  offline).
- [x] **Telegram alerts + control**: `TelegramNotifier` (notify-only, resilient,
  5s timeout) and a two-way command listener — `/kill`, `/arm`, `/equity`,
  `/risk`, `/status` — authorised to the configured chat only.
- [x] **Phase 4 — GCP deployment + monitoring**: `docker-compose.prod.yml`,
  `scripts/deploy.sh`, 5-min `scripts/healthcheck.sh` cron, Sentry, FreqUI via
  SSH tunnel, `docs/deployment.md` with trade-only/no-withdrawal/IP-restricted
  key creation.
- [x] **Phase 5 — Execution journal & feedback loop**: SQLite journal of every
  entry/exit/skip; nightly `sync-trades.ts` reconciles fills against Binance
  `myTrades`; `weekly-report.ts` (real P&L, slippage bps, skip analysis, paper
  baseline); `export-csv.ts` SARS record.
- [ ] **Before mainnet**: run `docs/testnet-validation.md` (esp. OCO rests on
  the book) and clear the Phase 1 graduation bar on out-of-sample data.
- [ ] **Phase 6 — Iteration**: hyperopt (in-sample only), parallel
  strategies, dynamic pairlists.

## Funding model (context, not code)

ZAR enters/exits via VALR; USDT moves between VALR and Binance manually. The
system trades within the Binance spot balance but never moves funds off the
exchange — withdrawal permission is disabled on the API key.
