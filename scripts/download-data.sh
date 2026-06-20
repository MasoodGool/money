#!/usr/bin/env bash
# Download Binance spot OHLCV for the whitelist pairs at the timeframes the
# strategies and backtests use (15m, 1h, 4h, 1d). Downloads from DOWNLOAD_FROM
# (default 2024-01-01) to now, so the data fully covers both backtest
# windows (in-sample 2024-01 -> 2025-06, out-of-sample 2025-07 ->).
# Data lands in bot/user_data/data/binance/ (gitignored).
#
# Runs natively if a `freqtrade` binary is available (set FREQTRADE_BIN to
# point at a venv, e.g. ~/.ft/bin/freqtrade), otherwise via Docker.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/_freqtrade.sh
source "$(dirname "$0")/_freqtrade.sh"

FROM="${DOWNLOAD_FROM:-20240101}"

# 15m is for the day-trading/scalp strategies; it ~4x's the download size.
ft download-data --timeframes 15m 1h 4h 1d --timerange "${FROM}-" "$@"
