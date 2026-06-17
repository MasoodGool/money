# tests/

Cross-cutting test home.

## Bot (pytest)

`test_baseline_trend.py` drives the strategy's `populate_*` methods with
synthetic OHLCV frames and hand-placed indicator values, asserting the
entry/exit columns fire on exactly the intended rows (and never on a
future-leaking one). Run inside an environment with freqtrade installed:

```bash
pip install freqtrade==2025.12 pytest      # or use a venv
python -m pytest tests/ -q
```

## Backtests (require market data + egress)

`scripts/backtest.sh` runs `BaselineTrend` over the in-sample and
out-of-sample windows. It needs candles (`scripts/download-data.sh`) and
outbound access to Binance for market metadata, so it runs on a machine /
session with open egress — not in the restricted dev sandbox.

## Concierge (vitest)

Service tests live next to the code in `concierge/test/`; run with
`npm test` from `concierge/`.
