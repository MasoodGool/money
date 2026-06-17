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
- [ ] **Phase 1 — Baseline strategy + backtesting discipline**: `BaselineTrend`
  (EMA20/50 cross + RSI + volume, 4h), look-ahead-audited; in-sample
  2024-01 → 2025-06, out-of-sample 2025-07 → touched once; fees 0.1%/side,
  slippage 0.03%. Graduation bar: positive out-of-sample expectancy after
  fees+slippage, max drawdown < 20%, ≥ 30 trades in sample.
- [~] **Auto-execution engine** (replaces the manual Telegram-ticket plan):
  Concierge sizes (1% rule + 20% clamp), guards (kill switch, 3% daily-loss
  breaker, per-`trade_id` idempotency), and places a market entry + resting
  OCO stop/TP bracket via ccxt against Binance testnet. Risk and executor
  logic are unit-tested with a fake venue; the live ccxt OCO path still needs
  testnet validation (egress is blocked in CI/dev here).
- [x] **Telegram notifications**: `TelegramNotifier` pushes notify-only alerts
  via the Bot API (selected when `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` are
  set, else falls back to stdout). Resilient — a Telegram outage is logged and
  never breaks order execution; sends are bounded by a 5s timeout. Unit-tested
  with an injected transport. (Live delivery unverified here — `api.telegram.org`
  is egress-blocked in dev.)
- [ ] **Telegram control commands**: `/equity`, `/kill`, `/risk` (inbound; the
  notifier is currently one-way).
- [ ] **Phase 4 — GCP deployment + monitoring**: e2-small VM, Sentry,
  healthcheck cron, tunnel-only FreqUI, documented key creation (trade-only,
  no withdrawal, IP-restricted).
- [ ] **Phase 5 — Execution journal & feedback loop**: nightly trade-history
  sync, weekly paper-vs-real report, CSV export (SARS record).
- [ ] **Phase 6 — Iteration**: hyperopt (in-sample only), parallel
  strategies, dynamic pairlists.

## Funding model (context, not code)

ZAR enters/exits via VALR; USDT moves between VALR and Binance manually. The
system trades within the Binance spot balance but never moves funds off the
exchange — withdrawal permission is disabled on the API key.
