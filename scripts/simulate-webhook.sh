#!/usr/bin/env bash
# Simulate a freqtrade entry webhook against the running Concierge.
# Mirrors the payload shape configured in config.dryrun.json.
# Usage: ./scripts/simulate-webhook.sh [host]   (default http://127.0.0.1:3000)
set -euo pipefail

HOST="${1:-http://127.0.0.1:3000}"

curl -sS -X POST "${HOST}/signal" \
    -H 'Content-Type: application/json' \
    -d '{
        "type": "entry",
        "trade_id": "9999",
        "exchange": "binance",
        "pair": "SOL/USDT",
        "direction": "long",
        "open_rate": "142.30",
        "amount": "0.611",
        "stake_amount": "87",
        "stake_currency": "USDT",
        "current_rate": "142.31",
        "enter_tag": "simulated",
        "open_date": "2026-06-12 10:00:00"
    }'
echo
