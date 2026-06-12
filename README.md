# signal-engine

A signal generation and alerting system built on [freqtrade](https://www.freqtrade.io/).
**This is not an auto-trading bot.** Freqtrade runs in dry-run mode permanently
against Binance spot data. Every signal becomes a Telegram ticket; a human
reviews it and executes manually in the Binance app. No component in this
system ever holds credentials that can move money.

## Hard Invariants

These are non-negotiable. Treat any change that violates one as a bug.

1. **`dry_run: true`, always.** The system never goes live. Any change setting
   it to `false` is a bug.
2. **The Binance API key is read-only** — market data + account/trade-history
   reads only. No trade permission, no withdrawal permission, ever.
   IP-restricted to the deployment VM's static IP. (Phase 0 needs no key at
   all: dry-run uses public market data.)
3. **Out-of-sample backtest data is touched once per strategy version.**
   No re-tuning against it.
4. **Every ticket carries absolute stop/TP prices, step-size-correct quantity,
   and a size derived from the 1% risk rule.**
5. **A signal is never silently dropped** — degraded tickets over no tickets.
6. **No public ports except SSH.** FreqUI via SSH tunnel/Tailscale only. The
   Concierge binds to loopback only.

## Architecture

```
Binance public/read-only data ──→ freqtrade (dry-run, Docker, Python)
                                      │ entry/exit signal
                                      ▼
                               webhook (localhost) ──→ Concierge (Docker, TypeScript)
                                                          │ risk sizing, ticket build
                                                          ▼
                                                    Telegram ticket ──→ Human ──→ executes on Binance app
                                                                                     │
                                            /executed command + nightly Binance     ▼
                                            trade-history sync ──────────→ journal SQLite
```

- **freqtrade** (Python) owns strategies, dry-run paper trading, backtesting.
  Its native Telegram (Phase 2) sends daily summaries and bot-health messages
  only.
- **Concierge** (TypeScript, Node 22, Fastify) receives freqtrade's
  entry/exit webhooks and will own risk sizing, ticket formatting, journal
  commands, and the nightly trade-history sync. Strategy code (Python) and
  operational logic (TypeScript) stay cleanly separated.

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
├── concierge/                  # TypeScript service (Fastify, vitest)
├── scripts/
│   ├── download-data.sh        # 2y of 1h/4h/1d for the whitelist
│   └── simulate-webhook.sh     # POST a fake entry signal at the Concierge
└── tests/                      # pytest (bot) — arrives in Phase 1
```

## Quickstart

```bash
cp .env.example .env            # fill in later phases' secrets; chmod 600
docker compose up -d            # freqtrade dry-run + concierge

# Watch signals arrive in the Concierge log
docker compose logs -f concierge

# Simulate a freqtrade entry webhook
./scripts/simulate-webhook.sh

# Download 2 years of candles for backtesting
./scripts/download-data.sh
```

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
- [ ] **Phase 2 — Telegram trade tickets**: executable tickets (live
  bid/ask, absolute stop/TP, step-size-correct quantity, staleness guard,
  no-drop fallback).
- [ ] **Phase 3 — Risk layer**: 1% risk sizing from `risk.json`, 20% position
  clamp, 3% daily-loss circuit breaker, `/risk` command.
- [ ] **Phase 4 — GCP deployment + monitoring**: e2-small VM, Sentry,
  healthcheck cron, tunnel-only FreqUI, documented read-only key creation.
- [ ] **Phase 5 — Execution journal & feedback loop**: `/executed`,
  `/skipped`, nightly trade-history sync, weekly paper-vs-real report,
  CSV export (SARS record).
- [ ] **Phase 6 — Iteration**: hyperopt (in-sample only), parallel
  strategies, dynamic pairlists.

## Funding model (context, not code)

ZAR enters/exits via VALR; USDT moves between VALR and Binance manually.
The system never touches funds.
