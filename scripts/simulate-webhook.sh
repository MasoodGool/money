#!/usr/bin/env bash
# Fire a synthetic entry or exit at the running Concierge — the fast way to
# exercise the real execution path on a dummy (testnet) account without
# waiting for a live 4h EMA cross.
#
# With KILL_SWITCH=0 and a testnet key in .env, an "entry" places a REAL
# testnet market buy + OCO bracket; "exit" closes the matching position.
#
# Usage:
#   ./scripts/simulate-webhook.sh [entry|exit] [trade_id] [pair] [price]
# Examples:
#   ./scripts/simulate-webhook.sh entry 5001 SOL/USDT 142.30
#   ./scripts/simulate-webhook.sh exit  5001 SOL/USDT 150.00
# Override the target with CONCIERGE_URL (default http://127.0.0.1:3000).
set -euo pipefail

SIDE="${1:-entry}"
TRADE_ID="${2:-$RANDOM}"   # fresh id by default so idempotency won't skip it
PAIR="${3:-SOL/USDT}"
PRICE="${4:-142.30}"
HOST="${CONCIERGE_URL:-http://127.0.0.1:3000}"

if [ "$SIDE" = "exit" ]; then
    payload=$(printf '{"type":"exit","trade_id":"%s","pair":"%s","close_rate":"%s","exit_reason":"simulated"}' \
        "$TRADE_ID" "$PAIR" "$PRICE")
else
    payload=$(printf '{"type":"entry","trade_id":"%s","exchange":"binance","pair":"%s","direction":"long","open_rate":"%s","current_rate":"%s","enter_tag":"simulated"}' \
        "$TRADE_ID" "$PAIR" "$PRICE" "$PRICE")
fi

echo "POST ${SIDE} #${TRADE_ID} ${PAIR} @ ${PRICE} -> ${HOST}/signal"
curl -sS -X POST "${HOST}/signal" -H 'Content-Type: application/json' -d "$payload"
echo
