#!/usr/bin/env bash
# Download Binance spot OHLCV for the whitelist pairs at the timeframes the
# strategies and backtests use (1h, 4h, 1d). Downloads from DOWNLOAD_FROM
# (default 2024-01-01) to now, so the data fully covers both backtest
# windows (in-sample 2024-01 -> 2025-06, out-of-sample 2025-07 ->).
# Data lands in bot/user_data/data/binance/ (gitignored).
set -euo pipefail
cd "$(dirname "$0")/.."

FROM="${DOWNLOAD_FROM:-20240101}"

docker compose run --rm freqtrade download-data \
    --config /freqtrade/user_data/config/config.backtest.json \
    --timeframes 1h 4h 1d \
    --timerange "${FROM}-" \
    "$@"
