#!/usr/bin/env bash
# Reproducible backtest: runs BaselineTrend over the in-sample and
# out-of-sample windows and prints both results for comparison.
#
# Runs natively if `freqtrade` is available (set FREQTRADE_BIN to point at a
# venv), otherwise via Docker — see scripts/_freqtrade.sh.
#
# Backtesting discipline (Phase 1):
#   - IN-SAMPLE   2024-01-01 → 2025-06-01 : tune here, as often as you like.
#   - OUT-OF-SAMPLE 2025-07-01 → present  : touch ONCE per strategy version.
#     Re-running it after seeing the result and tweaking the strategy is the
#     cardinal sin this pipeline exists to prevent.
#
# Costs: --fee folds Binance spot taker (0.10%/side) together with the 0.03%
# slippage assumption => 0.13%/side. Override with FEE=... to refine once
# Phase 5 produces a real slippage distribution.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/_freqtrade.sh
source "$(dirname "$0")/_freqtrade.sh"

STRATEGY="${STRATEGY:-BaselineTrend}"
FEE="${FEE:-0.0013}"
INSAMPLE="${INSAMPLE:-20240101-20250601}"
OUTSAMPLE="${OUTSAMPLE:-20250701-}"

run() {
    local label="$1" timerange="$2"
    echo
    echo "============================================================"
    echo " ${label}  (${timerange})  strategy=${STRATEGY}  fee=${FEE}"
    echo "============================================================"
    ft backtesting \
        --strategy "${STRATEGY}" \
        --timeframe 4h \
        --timerange "${timerange}" \
        --fee "${FEE}" \
        --enable-protections
}

run "IN-SAMPLE (tune freely)" "${INSAMPLE}"
run "OUT-OF-SAMPLE (touch once!)" "${OUTSAMPLE}"

cat <<'NOTE'

------------------------------------------------------------
Graduation bar (must hold on OUT-OF-SAMPLE):
  - positive expectancy after fees + slippage
  - max drawdown < 20%
  - >= 30 trades in sample
Only a strategy that clears this is a candidate for the mainnet flip.
NOTE
