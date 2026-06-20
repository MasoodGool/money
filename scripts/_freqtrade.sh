# Shared runner: defines an `ft` function that invokes a freqtrade subcommand
# against config.backtest.json, using a native freqtrade if available and
# falling back to Docker. Sourced by download-data.sh and backtest.sh.
#
# Selection:
#   - FREQTRADE_BIN set        -> that binary (e.g. ~/.ft/bin/freqtrade)
#   - `freqtrade` on PATH      -> native
#   - else a running Docker    -> docker compose run --rm freqtrade
#   - else                     -> error with setup guidance

if [ -n "${FREQTRADE_BIN:-}" ] || command -v freqtrade >/dev/null 2>&1; then
    _FT_BIN="${FREQTRADE_BIN:-freqtrade}"
    ft() {
        local sub="$1"; shift
        "$_FT_BIN" "$sub" \
            --userdir bot/user_data \
            --config bot/user_data/config/config.backtest.json \
            "$@"
    }
elif docker info >/dev/null 2>&1; then
    ft() {
        local sub="$1"; shift
        docker compose run --rm freqtrade "$sub" \
            --config /freqtrade/user_data/config/config.backtest.json \
            "$@"
    }
else
    cat >&2 <<'EOF'
No way to run freqtrade found.
  - Native (recommended on macOS, no Docker):
      python3 -m venv ~/.ft && source ~/.ft/bin/activate
      pip install -U pip && pip install "freqtrade==2025.12"
      # then re-run this script (freqtrade is now on PATH), or set:
      #   export FREQTRADE_BIN=~/.ft/bin/freqtrade
  - Or start Docker Desktop and re-run.
EOF
    exit 1
fi
