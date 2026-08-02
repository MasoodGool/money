# signal-engine

A trading bot that **follows one X account, has Claude read every tweet, and
executes the calls** — with a risk gate, a kill switch and a resting
stop/take-profit bracket in front of every order.

The account is [@TradexWhisperer](https://x.com/TradexWhisperer), which calls
**US equities** ($MU, $PLTR, $RKLB, $SNDK, $TSM). Orders go to **Alpaca** by
default; `VENUE=binance` switches the same pipeline to crypto spot for an
account that calls crypto.

Every new tweet is classified; the clear directional calls become orders,
everything else is logged and ignored. A month of history can be replayed in
analysis-only mode first, to see what the account actually calls before any
money is involved.

> This project began as a freqtrade technical-strategy bot. The strategies
> failed their graduation bar (see [Phase status](#phase-status)), and the
> signal source is now the tweet feed. freqtrade is kept for backtesting
> research only, behind an opt-in compose profile.

## Hard Invariants

These are non-negotiable. Treat any change that violates one as a bug.

1. **Historical tweets are never traded.** The backfill is analysis-only. A
   stale call is a dead call; `TWEET_MAX_AGE_MINUTES` enforces the same rule
   live.
2. **Only allowlisted assets are tradable.** A tweet naming anything outside
   `TWEET_ASSETS` is recorded and ignored, never bought.
3. **Real money is always an explicit opt-in.** `ALPACA_PAPER=1` and
   `BINANCE_TESTNET=1` are the defaults. On the crypto path the Binance key
   has TRADE permission but **never** withdrawal, and is IP-restricted to the
   deployment host.
4. **Every order passes the risk gate first:** size from the 1% rule, capped
   at the max-position %, step-size-rounded, min-notional-checked, and a
   resting OCO stop/TP bracket placed so an open position is always protected.
5. **A signal is never silently dropped.** Every tweet is logged with its
   classification and the decision taken. Feed and analyst failures alert
   rather than returning "nothing new".
6. **Long-only.** A bearish tweet can only close a position we hold; it never
   opens a short, on either venue.
7. **Equities respect market hours and the PDT rule.** Entries are refused
   outside the session, and refused under $25k equity once the day-trade
   allowance is spent. Exits are never blocked by the day-trade limit.
8. **No public ports except SSH.** The Concierge binds to loopback only.
9. **If freqtrade runs at all, it stays `dry_run: true`** — research only, it
   never executes.

Two software cut-offs back these up: `KILL_SWITCH=1` (default) makes the
Concierge notify-only, and the venue's fake-money mode (`ALPACA_PAPER=1` /
`BINANCE_TESTNET=1`, both default on) keeps orders off real funds. A fresh or
misconfigured deploy therefore trades nothing.

## Architecture

```
@TradexWhisperer ──poll──▶ TweetPoller (cursor: x_since_id, new tweets only)
                                │
                                ▼
                        TweetAnalyzer — Claude, strict JSON schema
                                │  {action, asset, conviction, confidence, …}
                                ▼
                        TweetRouter  — idempotency · allowlist · quality
                                │            freshness · one-per-symbol
                                │            market hours + PDT (equities)
                                ▼
                        Executor (TypeScript)
                          ├─ risk gate: 1% sizing + max-position clamp
                          ├─ kill switch + daily-loss circuit breaker
                          └─ Alpaca (paper → live) | Binance (testnet → main)
                                │ market buy + resting OCO stop/TP bracket
                                ▼
                        Brokerage account         Telegram (notify-only)
                                │
                                ▼  nightly trade-history sync → journal SQLite
```

Everything upstream of the Executor can only *narrow* what gets traded. The
sizing, breakers and bracket are unchanged from the original design and are
still the last word before an order.

The `/signal` webhook endpoint remains for freqtrade research runs; it is no
longer the primary path.

## Repo layout

```
├── docker-compose.yml          # concierge (+ optional freqtrade profile)
├── .env.example                # template; never commit .env
├── concierge/                  # the whole runtime (TypeScript, Node 22)
│   ├── src/
│   │   ├── alpaca-venue.ts     # US equities broker (default venue)
│   │   ├── tweets/
│   │   │   ├── x-source.ts     # X API v2 timeline reader (+ fixture source)
│   │   │   ├── analyzer.ts     # Claude classifier + free prefilter
│   │   │   ├── router.ts       # the gates: tweet -> trade decision
│   │   │   ├── poller.ts       # backfill (paper) + forward feed (live)
│   │   │   ├── market-gate.ts  # market hours + pattern-day-trader guard
│   │   │   ├── day-trade-ledger.ts # local same-day round-trip counter
│   │   │   ├── symbols.ts      # asset allowlist (equity + crypto)
│   │   │   └── tweet-log.ts    # audit log of every tweet + classification
│   │   ├── risk.ts             # 1% sizing + clamps (pure)
│   │   ├── executor.ts         # guards → place order + OCO bracket
│   │   ├── venue.ts            # ExecutionVenue interface
│   │   ├── binance-venue.ts    # ccxt Binance adapter (crypto, optional)
│   │   └── app.ts / index.ts   # Fastify wiring
│   ├── scripts/
│   │   ├── demo-tweets.ts      # offline end-to-end demo, no keys needed
│   │   └── backfill-tweets.ts  # one-month history pass, analysis only
│   └── test/                   # vitest — 144 tests, no network
├── bot/user_data/              # freqtrade strategies (research only)
└── docs/
    ├── tweet-signals.md        # operating manual for the tweet path
    ├── deployment.md
    └── testnet-validation.md
```

## Quickstart

```bash
cp .env.example .env            # chmod 600; leave KILL_SWITCH=1 / ALPACA_PAPER=1

# See the pipeline work end to end with no credentials at all:
cd concierge && npm install && npm run demo:tweets

# Read the last month of the account, classify every tweet, place nothing:
npm run backfill:tweets         # needs X_BEARER_TOKEN + ANTHROPIC_API_KEY

# Run the live feed (notify-only while KILL_SWITCH=1):
cd .. && docker compose up -d && docker compose logs -f concierge
```

**Credentials.** `X_BEARER_TOKEN` needs a **paid X API tier** — reading a user
timeline (`GET /2/users/:id/tweets`) is not available on the free plan.
`ANTHROPIC_API_KEY` pays for the analyst. `ALPACA_API_KEY_ID` /
`ALPACA_API_SECRET_KEY` are the broker keys (paper and live are *different*
key pairs). With the X or Anthropic key missing, the feed stays off and says
so at boot rather than looking like a quiet account.

**Arming (paper):** create paper keys at <https://app.alpaca.markets>, put them
in `.env`, set `KILL_SWITCH=0`, and restart. It boots logging
`AUTO-EXECUTION ARMED on Alpaca PAPER`. Validate a few round-trips during
market hours — **especially that the OCO bracket actually rests on the book** —
before ever setting `ALPACA_PAPER=0` for real money.

Concierge development:

```bash
cd concierge
npm test          # vitest — no network, no keys
npm run typecheck
npm run dev       # local server with reload
```

Backtesting research (optional):

```bash
docker compose --profile freqtrade up -d
./scripts/backtest.sh
```

The freqtrade container runs as uid 1000 (`ftuser`); if `bot/user_data` is
owned by another user, `chown -R 1000:1000 bot/user_data`.

## Tuning the tweet gates

Set in `.env`; full detail in [docs/tweet-signals.md](docs/tweet-signals.md).

| Variable | Default | Effect |
|---|---|---|
| `VENUE` | `alpaca` | `alpaca` (US equities) or `binance` (crypto spot). |
| `TWEET_ASSETS` | `MU,PLTR,RKLB,SNDK,TSM,NVDA` | The only assets a tweet can make us buy. Defaults to `BTC,ETH,SOL` when `VENUE=binance`. |
| `TWEET_MIN_CONFIDENCE` | `0.75` | Analyst confidence floor for entries. |
| `TWEET_MIN_CONVICTION` | `medium` | Conviction floor for entries. |
| `TWEET_MAX_AGE_MINUTES` | `30` | Never chase a call older than this. |
| `TWEET_ALLOW_SPECULATIVE` | `0` | Act on "this could run" musings too. |
| `TWEET_POLL_SECONDS` | `60` | How often to check for new tweets. |
| `ALPACA_PAPER` | `1` | Paper trading. `0` is real money. |
| `ALPACA_DAY_TRADE_LIMIT` | `3` | Day trades allowed under the equity floor. |
| `ALPACA_PDT_EQUITY_FLOOR` | `25000` | Above this, the PDT rule stops applying. |

Exits deliberately bypass the confidence/conviction floors: closing risk
should never be blocked by a hedged-sounding tweet.

**Equities are not crypto.** Whole shares only (the OCO bracket rejects
fractions), regular session only (an after-hours call is refused, not queued
to the open), and the pattern-day-trader rule applies under $25k. Details and
rationale: [docs/tweet-signals.md](docs/tweet-signals.md).

## Phase status

- [x] **Phase 0 — Scaffold & local dev**: compose, webhook plumbing, data
  download script.
- [x] **Phase 1 — Baseline strategy + backtesting discipline**: `BaselineTrend`
  (EMA20/50 + RSI + volume, 4h) with no look-ahead and deterministic signal
  tests. **V1 FAILED the graduation bar** — it lost in both a +58% bull
  (in-sample) and a −41% bear (out-of-sample), with backwards risk/reward.
  Out-of-sample is spent for V1.
- [~] **`BaselineTrendV2`** (parked): regime filter + trailing stop + 12-pair
  universe. Signal logic unit-tested; never cleared a walk-forward run. Kept
  for research, not wired to execution.
- [x] **Auto-execution engine**: 1% sizing + 20% clamp, kill switch, 3%
  daily-loss breaker, per-`trade_id` idempotency, step-size + min-notional,
  market entry + resting OCO bracket via ccxt behind an `ExecutionVenue`.
- [x] **Durable state + boot reconciliation**: `node:sqlite` persists open
  positions, idempotency, daily tally, equity, kill switch.
- [x] **Telegram alerts + control**: notify-only alerts plus `/kill`, `/arm`,
  `/equity`, `/risk`, `/status`, authorised to one chat.
- [x] **Phase 4 — GCP deployment + monitoring**: prod compose, deploy and
  healthcheck scripts, Sentry, `docs/deployment.md`.
- [x] **Phase 5 — Execution journal & feedback loop**: SQLite journal, nightly
  Binance reconciliation, weekly report, CSV export for SARS.
- [x] **Phase 6 — Tweet signal source**: X API v2 reader, Claude analyst with
  a strict JSON schema, gated router, forward poller with a durable cursor,
  analysis-only month backfill, and a tweet-by-tweet audit log.
- [x] **Phase 7 — Equities venue**: Alpaca `ExecutionVenue` (whole shares,
  async fills, sell-side OCO bracket), market-hours gate, and a local
  pattern-day-trader ledger — Alpaca stopped reporting `daytrade_count` on
  2026-07-06, so the count is kept here.
- [ ] **Before arming**: run `npm run backfill:tweets` and review the
  classifications; run the live feed notify-only for a few days; then paper
  trade and confirm the OCO bracket rests on the book.
- [ ] **Next**: evaluate the classifier against the backfill labels, decide
  whether after-hours calls should queue to the open, decide whether
  tweet-stated stop levels should override the fixed 5% stop, and consider
  multi-account support.

## Funding model (context, not code)

**Equities (Alpaca):** a USD brokerage balance. Alpaca is a US broker — check
what onboarding from South Africa requires before assuming the live path is
available to you; the paper path works regardless. Note T+1 settlement and
that the PDT rule binds hard under $25k.

**Crypto (Binance):** ZAR enters/exits via VALR; USDT moves between VALR and
Binance manually. The system trades within the Binance spot balance but never
moves funds off the exchange — withdrawal permission is disabled on the key.
