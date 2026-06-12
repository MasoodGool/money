#!/usr/bin/env bash
# Download 2 years of Binance spot OHLCV for the whitelist pairs at the
# timeframes the strategies and backtests use (1h, 4h, 1d).
# Data lands in bot/user_data/data/binance/ (gitignored).
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose run --rm freqtrade download-data \
    --config /freqtrade/user_data/config/config.backtest.json \
    --timeframes 1h 4h 1d \
    --days 730 \
    "$@"
