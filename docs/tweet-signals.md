# Tweet-driven signals

The Concierge follows one X account, has Claude classify every tweet it posts,
and routes the clear calls through the existing risk gate onto a broker.
This document is the operating manual for that path: how it works, what it
refuses to do, and how to bring it up safely.

**Two venues are supported**, chosen with `VENUE`:

| `VENUE` | Market | Fake-money mode | Hours | Day-trade rule |
|---|---|---|---|---|
| `alpaca` (default) | US equities | `ALPACA_PAPER=1` | 09:30–16:00 ET, weekdays | Yes — PDT applies under $25k |
| `binance` | Crypto spot | `BINANCE_TESTNET=1` | 24/7 | No |

The default is Alpaca because [@TradexWhisperer](https://x.com/TradexWhisperer)
calls **stocks** — recent theses are $MU, $PLTR, $RKLB, $SNDK, $TSM. Pointing
the bot at Binance while following that account means every call lands outside
the allowlist and nothing ever trades.

```
@TradexWhisperer  ──poll──▶  TweetPoller
                                 │  new tweets only (cursor: x_since_id)
                                 ▼
                            TweetAnalyzer (Claude, strict JSON schema)
                                 │  {action, asset, conviction, confidence, …}
                                 ▼
                            TweetRouter  ── gates ──▶  Executor  ──▶  Alpaca
                                 │                       │           (or Binance)
                                 ▼                       ▼
                            tweet log (SQLite)      risk gate + OCO bracket
```

## Three things this deliberately will not do

**1. It does not trade the backfill.** The month of history is read in
*paper* mode: classified, logged, reported — never ordered. A call from three
weeks ago has already played out; entering it now buys a price that moved
long ago, and "catching up" on a month of calls in one burst is a month of
bad fills at once. `TWEET_MAX_AGE_MINUTES` (default 30) enforces the same rule
on the live feed. What the backfill *is* for is calibration: how often the
account actually calls trades, how the classifier reads its style, and where
the gates land — evidence you want before arming anything.

**2. It does not short.** Both venues are configured long-only: Binance
**spot** has no short, and the Alpaca path never submits a short sale even
where the broker would allow one. A bearish tweet can only ever close a
position we already hold. If nothing is held, the call is recorded and
ignored.

**3. It does not queue calls to the next open.** On equities, a tweet posted
after 16:00 ET is refused, not held until 09:30 the next morning. Filling
hours later at a gapped open is exactly the staleness the freshness gate
exists to prevent. This does mean after-hours calls are missed — a deliberate
trade-off, and the single most likely thing you will want to revisit.

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
| 6 | One position per symbol | "Adding to $MU" does not stack a second position. |
| 7 | Market gate | Venue open, account not blocked, and (equities, under $25k) day-trade headroom remaining. |

Past that point nothing changed: the 1% sizing rule, the 20% position clamp,
the 3% daily-loss breaker, step-size/min-notional checks, the kill switch and
the resting OCO stop/TP bracket all apply exactly as before.

## What is different about equities

| | Crypto (Binance) | Equities (Alpaca) |
|---|---|---|
| Order size | Fractional | **Whole shares.** Alpaca allows fractional quantities on plain market orders but not on the OCO bracket, and we never hold an unbracketed position. Sizing rounds down, so a $2 000 target on a $214 stock buys 9 shares, not 9.34. |
| Bracket | Binance `orderList/oco` | Alpaca `order_class: "oco"` — sell-side only, against an open long. Same shape, so the buy-then-bracket flow is unchanged. |
| Fills | Effectively synchronous | **Asynchronous.** `POST /v2/orders` returns `accepted` with no fill price; the venue polls until the order is terminal so the bracket is derived from the real fill. A partial fill is bracketed at the quantity actually bought. |
| Entry order TIF | — | `day` — an unfilled market order expires with the session rather than waking up at tomorrow's open. The bracket is `gtc` so the position stays protected overnight. |
| Hours | 24/7 | Regular session only. Pre/post-market is not used: market orders cannot run there, and limit-order handling is a bigger change than it looks. |
| Regulatory | None | **Pattern day trader.** Three day trades per five business days under $25k equity; a fourth can freeze the account for 90 days. |

### The PDT guard, and why it counts locally

Alpaca used to report the remaining allowance as `daytrade_count`. That field
was **removed from account responses on 2026-07-06** (the FINRA
intraday-margin migration) and now defaults to null, so the broker no longer
tells us how many day trades are left.

The bot therefore keeps its own ledger: every time it closes a position it
opened the same trading day (New York time), it records the date. Entries are
refused once the count reaches `ALPACA_DAY_TRADE_LIMIT` while equity is below
`ALPACA_PDT_EQUITY_FLOOR`, and also whenever Alpaca's own `pattern_day_trader`
flag is set on a small account.

Two deliberate biases:

- The window is **seven calendar days**, not five business days. That always
  spans at least five business days, so it can over-count across a holiday
  week and block a trade that would have been allowed. Wrong in the safe
  direction.
- **Exits are never blocked by the limit.** Refusing to close would leave real
  risk on the book to protect a compliance counter. Positions opened before
  the ledger existed have no entry timestamp and count as overnight holds.

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
#    Uses equity fixtures in the style the account actually posts.
cd concierge && npm run demo:tweets

# 1. Read a month of history and see what the account actually calls.
#    Analysis only — this cannot place an order.
npm run backfill:tweets              # or: -- --days 14

# 2. Tune the gates against what you just read, in .env:
#    TWEET_MIN_CONFIDENCE / TWEET_MIN_CONVICTION / TWEET_ASSETS

# 3. Run the live feed notify-only (KILL_SWITCH=1). Real classifications,
#    real Telegram alerts, zero orders. Leave it a few days.
docker compose up -d && docker compose logs -f concierge

# 4. Arm on Alpaca PAPER: KILL_SWITCH=0, ALPACA_PAPER=1.
#    Confirm during market hours that the OCO bracket actually rests on the
#    book after an entry (docs/testnet-validation.md).

# 5. Real money is ALPACA_PAPER=0 — a deliberate, separate decision.
```

Steps 3 and 4 are where the classifier earns trust. Every tweet it read and
every decision it made is in `concierge-tweets.sqlite`, so a week of
notify-only running gives you a labelled dataset to argue with.

## Credentials

| Variable | Notes |
|---|---|
| `X_BEARER_TOKEN` | X API v2 app bearer token. **Reading a user timeline (`GET /2/users/:id/tweets`) requires a paid X API tier** — the free tier cannot do it. |
| `ANTHROPIC_API_KEY` | The analyst. Cost scales with tweets that pass the prefilter, not with total tweets. |
| `ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY` | Broker credentials. **Paper and live are different key pairs** — a paper key against the live host fails to authenticate. |

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
- **Market gate unreachable** — treated as closed. If we cannot confirm the
  venue is open and the account is clear, we do not trade.
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
- **After-hours calls are dropped, not queued.** See deviation 3 above.
- **No options, no shorts, no multi-leg.** The account sometimes discusses
  strategies this bot cannot express; those tweets classify as calls and then
  fail the allowlist or the long-only rule.
- **Earnings and halts are not modelled.** A tweet landing minutes before an
  earnings print is treated like any other, and a halted symbol simply fails
  to fill.
- **Tweet text only.** Charts posted as images, and calls made only in a
  quoted tweet, are not read.
- **No entry price from the tweet.** Even when a tweet names a level, the
  entry is marked to the live market price. Sizing off a stated level while
  filling at market would misstate the risk.
- **The classifier is not evaluated yet.** The backfill produces the data to
  evaluate it; nobody has yet said "these labels are right". Do that before
  step 4, not after.
