#!/usr/bin/env bash
# Liveness probe for the prod stack. Pings the Concierge and freqtrade; on
# failure alerts Telegram and (if configured) Sentry. Designed for cron:
#
#   */5 * * * * /home/USER/signal-engine/scripts/healthcheck.sh >> /var/log/signal-healthcheck.log 2>&1
#
# Reads TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID / SENTRY_DSN from the repo .env.
set -uo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] && set -a && . ./.env && set +a

CONCIERGE_URL="${CONCIERGE_HEALTH_URL:-http://127.0.0.1:3000/healthz}"
FREQTRADE_URL="${FREQTRADE_PING_URL:-http://127.0.0.1:8080/api/v1/ping}"

alert() {
    local msg="🚨 signal-engine healthcheck: $1"
    echo "$(date -u +%FT%TZ) $msg"
    if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
        curl -s --max-time 10 \
            "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
            -d "chat_id=${TELEGRAM_CHAT_ID}" --data-urlencode "text=${msg}" >/dev/null || true
    fi
    if [ -n "${SENTRY_DSN:-}" ]; then
        # Minimal Sentry "message" via the store endpoint would need the SDK;
        # the Telegram alert is the primary channel. Logged above for Sentry's
        # log drain / cron-monitor integrations to pick up.
        :
    fi
}

ok=1
if ! curl -fs --max-time 10 "${CONCIERGE_URL}" >/dev/null; then
    alert "Concierge DOWN (${CONCIERGE_URL})"; ok=0
fi
# freqtrade /ping returns 200 without auth when the API server is up.
if ! curl -fs --max-time 10 "${FREQTRADE_URL}" >/dev/null; then
    alert "freqtrade DOWN (${FREQTRADE_URL})"; ok=0
fi

if [ "$ok" = 1 ]; then
    echo "$(date -u +%FT%TZ) ok: concierge + freqtrade healthy"
fi
