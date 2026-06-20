# Strategy research — candidates and protocol

A sandbox for testing strategies with no real money at risk. Real money for
the monthly-deposit goal stays in DCA; this is research.

## Candidate strategies

| Strategy | Premise | Timeframe | Source |
|---|---|---|---|
| `BaselineTrend` | EMA20/50 cross (trend) | 4h | ours — **failed** graduation |
| `BaselineTrendV2` | + regime filter + trailing stop | 4h | ours — **failed** worse |
| `BbandRsi` | mean reversion (RSI<30 + lower BB) | 1h | community (freqtrade-strategies, MIT) |
| `DonchianBreakout` | breakout (new N-period high) | 4h | ours (clean archetype) |
| `RsiPullback` | buy oversold dips in an uptrend | 4h | ours (clean archetype) |
| `ScalpEmaRsi` | aggressive day-trading momentum scalp | 15m | ours (clean archetype) |

Run one (native timeframe used unless you set `TIMEFRAME`). `download-data.sh`
now also fetches 15m for the scalper:

```bash
STRATEGY=DonchianBreakout FREQTRADE_BIN=~/.ft/bin/freqtrade ./scripts/backtest.sh
STRATEGY=ScalpEmaRsi      FREQTRADE_BIN=~/.ft/bin/freqtrade ./scripts/backtest.sh
STRATEGY=BbandRsi TIMEFRAME=1h FREQTRADE_BIN=~/.ft/bin/freqtrade ./scripts/backtest.sh
```

## Risk-capital ("disposable money, chasing reward") flavors

For money you can afford to lose and want a high-variance shot at a multiple:

1. **Concentrated momentum / breakout** (`DonchianBreakout`, few high-beta
   pairs, trailing stop): the most convex spot play — small frequent losses,
   rare big winner. Best reward-for-risk here.
2. **Aggressive day trading** (`ScalpEmaRsi`, 15m, high frequency): high
   variance but the fee+slippage drag fights every trade — expect the
   backtest to show cost bleed.
3. **Leverage**: NOT a separate strategy — it's a *multiplier* on whichever
   spot strategy you run. ~3x leverage ≈ 3x the P&L curve **and** ~3x the
   drawdown, with liquidation/wipeout once an adverse move hits ~1/leverage
   (≈33% at 3x). **Leveraging a no-edge strategy just loses faster.** So the
   sequence is: find a strategy with *positive spot expectancy* first, then
   leverage that. Until something clears the spot graduation bar, leverage is
   premature. (It also needs freqtrade futures mode + futures data + Concierge
   changes — our system is spot-only today.)

The aggressiveness *knobs* (live, via the Concierge) are separate from the
backtest: `RISK_PER_TRADE` (1% → 5–10%) and a concentrated whitelist raise
position size, but they don't create edge — they widen outcomes both ways.

Always audit for the look-ahead bias that inflates community results:

```bash
~/.ft/bin/freqtrade lookahead-analysis --userdir bot/user_data \
  --config bot/user_data/config/config.backtest.json --strategy <Name> --timerange 20240101-20250601
```

## The discipline (so we don't fool ourselves)

1. **Most published strategies are overfit or look-ahead-biased.** Expect most
   to fail. Great backtest numbers are a red flag, not a green light.
2. **Data snooping is the real trap.** Testing many strategies against the same
   out-of-sample window and picking the winner *is* overfitting — with enough
   tries you'll find a lucky one. Our 2024–2026 out-of-sample is largely spent
   (BaselineTrend V1 + V2).
3. **The clean protocol:**
   - Screen candidates on **in-sample** only; discard obvious losers.
   - Run `lookahead-analysis` on survivors.
   - Forward-test the best **1–2 on Binance testnet (paper) for weeks/months** —
     that's genuinely out-of-sample because it's the future, and it surfaces
     look-ahead bugs a backtest hides.
   - Only a strategy that survives all of the above earns a real-money
     conversation — and even then, only once the account is large enough that
     fixed infra cost is a rounding error.
