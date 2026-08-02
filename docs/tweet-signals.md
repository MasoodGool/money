# Tweet-driven signals

The Concierge follows one X account, has Claude classify every tweet it posts,
and routes the clear calls through the existing risk gate onto Binance spot.
This document is the operating manual for that path: how it works, what it
refuses to do, and how to bring it up safely.

```
@TradexWhisperer  ──poll──▶  TweetPoller
                                 │  new tweets only (cursor: x_since_id)
                                 ▼
                            TweetAnalyzer (Claude, strict JSON schema)
                                 │  {action, asset, conviction, confidence, …}
                                 ▼
                            TweetRouter  ── gates ──▶  Executor  ──▶  Binance
                                 │                       │
                                 ▼                       ▼
                            tweet log (SQLite)      risk gate + OCO bracket
```

## The two things this deliberately will not do

**1. It does not trade the backfill.** The month of history is read in
*paper* mode: classified, logged, reported — never ordered. A call from three
weeks ago has already played out; entering it now buys a price that moved
long ago, and "catching up" on a month of calls in one burst is a month of
bad fills at once. `TWEET_MAX_AGE_MINUTES` (default 30) enforces the same rule
on the live feed. What the backfill *is* for is calibration: how often the
account actually calls trades, how the classifier reads its style, and where
the gates land — evidence you want before arming anything.

**2. It does not short.** The account is on Binance **spot**, which is
long-only. A bearish tweet can only ever close a position we already hold. If
nothing is held, the call is recorded and ignored.

## Gates, in order

Everything the model returns is untrusted input. The router can only ever
*narrow* what the executor would do:

| # | Gate | Why |
|---|------|-----|
| 1 | Idempotency (`tweet:<id>`) | One decision per tweet, ever. A redelivered or re-fetched tweet cannot re-buy. |
| 2 | Actionable | The model must have read a real call. Commentary, promos and chart talk stop here. |
| 3 | Allowlist (`TWEET_ASSETS`) | Only pairs chosen in advance are tradable. This is the cap on a misread tweet or a pumped micro-cap. |
| 4 | Confidence / conviction / speculation | Entry-only quality floors. Exits bypass them on purpose — closing risk should never be blocked by a hedged-sounding tweet. |
| 5 | Freshness (`TWEET_MAX_AGE_MINUTES`) | A stale call is a dead call. |
| 6 | One position per symbol | "Adding to $SOL" does not stack a second position. |

Past that point nothing changed: the 1% sizing rule, the 20% position clamp,
the 3% daily-loss breaker, step-size/min-notional checks, the kill switch and
the resting OCO stop/TP bracket all apply exactly as before.

## The analyst

`claude-opus-5` with a **strict JSON schema**, so the output is always a valid
`TweetAnalysis` — no prose to parse, no ad-hoc regex. The prompt makes it a
classifier, not a trader: it reports what the tweet says and is told to prefer
`actionable: false` when a tweet is ambiguous, because a missed signal costs
nothing and a misread one places a real order.

A deterministic prefilter runs first and costs nothing: retweets, empty text,
and anything naming no allowlisted asset never reach the model. Most of a
timeline is commentary, and there is no reason to pay for it.

## Bringing it up

```bash
# 0. Offline: watch the whole pipeline run on fixture tweets, no keys needed.
cd concierge && npm run demo:tweets

# 1. Read a month of history and see what the account actually calls.
#    Analysis only — this cannot place an order.
npm run backfill:tweets              # or: -- --days 14

# 2. Tune the gates against what you just read, in .env:
#    TWEET_MIN_CONFIDENCE / TWEET_MIN_CONVICTION / TWEET_ASSETS

# 3. Run the live feed notify-only (KILL_SWITCH=1). Real classifications,
#    real Telegram alerts, zero orders. Leave it a few days.
docker compose up -d && docker compose logs -f concierge

# 4. Arm on Binance TESTNET: KILL_SWITCH=0, BINANCE_TESTNET=1.
#    Confirm the OCO bracket actually rests on the book (docs/testnet-validation.md).

# 5. Mainnet is BINANCE_TESTNET=0 — a deliberate, separate decision.
```

Steps 3 and 4 are where the classifier earns trust. Every tweet it read and
every decision it made is in `concierge-tweets.sqlite`, so a week of
notify-only running gives you a labelled dataset to argue with.

## Credentials

| Variable | Notes |
|---|---|
| `X_BEARER_TOKEN` | X API v2 app bearer token. **Reading a user timeline (`GET /2/users/:id/tweets`) requires a paid X API tier** — the free tier cannot do it. |
| `ANTHROPIC_API_KEY` | The analyst. Cost scales with tweets that pass the prefilter, not with total tweets. |

With either missing the feed stays **off** and says so at boot. That is
deliberate: a silently disabled feed is indistinguishable from a quiet
account, and you would never know you had stopped reading signals.

## Failure behaviour

- **X API error** (401/403/429/outage) — throws, logs, and alerts Telegram on
  the first failure and every 20th after. Never returns an empty timeline,
  which would look like "no new tweets".
- **Analyst error** — the tweet is logged with the failure as its decision and
  an alert fires. The tweet is not silently dropped.
- **No price for the symbol** — skipped with a reason; the entry is never
  sized off a guess.
- **Restart** — the cursor (`x_since_id`) is persisted per tweet, so a crash
  mid-batch neither replays decisions already made nor skips the rest.
- **Fresh deploy** — the cursor is *primed* to the newest existing tweet
  without processing the backlog, so a first boot doesn't treat the account's
  recent history as a flurry of live calls.

## Alerting

Telegram gets: every trade taken (from the executor), every *actionable* call
that was **not** taken and why, and every feed/analyst failure. Ordinary
commentary stays silent — the alert channel is for decisions, not a mirror of
the timeline.

## Known limits

- **One account.** The source interface is per-handle; following several
  accounts means several pollers and a policy for conflicting calls.
- **Tweet text only.** Charts posted as images, and calls made only in a
  quoted tweet, are not read.
- **No entry price from the tweet.** Even when a tweet names a level, the
  entry is marked to the live market price. Sizing off a stated level while
  filling at market would misstate the risk.
- **The classifier is not evaluated yet.** The backfill produces the data to
  evaluate it; nobody has yet said "these labels are right". Do that before
  step 4, not after.
