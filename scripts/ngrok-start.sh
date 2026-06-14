#!/usr/bin/env bash
#
# Start the saved ngrok tunnel for the HTTP MCP server. Run after first-time
# setup with: npm run start:ngrok
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
ENV_FILE="$ROOT/.env.local"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m  %s\n' "$*"; }
die()  { printf '\033[1;31mx\033[0m  %s\n' "$*" >&2; exit 1; }

print_connector_summary() {
  cat <<EOF

============================================================
waterloo-learn MCP over ngrok
============================================================

  Paste this connector URL into ChatGPT or Claude.ai:
    $URL

  Leave this terminal running. Ctrl+C stops ngrok and the local MCP server
  started by this script.

============================================================

EOF
}

write_connector_file() {
  cat >"$ROOT/.ngrok-connector.txt" <<EOF
Connector URL: $URL

Add this URL in ChatGPT or Claude.ai:
$URL
EOF
  chmod 600 "$ROOT/.ngrok-connector.txt"
}

[ -f "$ENV_FILE" ] || die ".env.local is missing. Run: npm run setup:ngrok"

# shellcheck disable=SC1090
set -a; . "$ENV_FILE" 2>/dev/null || true; set +a

PORT="${PORT:-8787}"
DOMAIN="${LEARN_MCP_NGROK_DOMAIN:-${NGROK_DOMAIN:-}}"
DOMAIN="${DOMAIN#http://}"
DOMAIN="${DOMAIN#https://}"
DOMAIN="${DOMAIN%%/*}"

[ -n "$DOMAIN" ] || die "No ngrok domain saved. Run: npm run setup:ngrok"
command -v ngrok >/dev/null 2>&1 || die "ngrok isn't installed. On macOS: brew install ngrok/ngrok/ngrok"

BASE="https://$DOMAIN"
URL="$BASE/mcp"

if [ "${LEARN_MCP_SKIP_AUTH_CHECK:-}" != "1" ]; then
  say "Checking saved LEARN session"
  npm run -s check:auth || die "LEARN session check failed. If the network is fine, run: npm run login"
fi

cat <<EOF

Starting waterloo-learn MCP over ngrok:
  Connector URL: $URL

Leave this terminal running. Ctrl+C stops the tunnel.

EOF

cleanup() {
  if [ "${STARTED_SERVER:-0}" = "1" ] && [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  if [ "$(curl -fsS "http://localhost:$PORT/health" 2>/dev/null || true)" = "ok" ]; then
    warn "Port $PORT is already serving the MCP health check; reusing that server."
    STARTED_SERVER=0
  else
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2 || true
    die "Port $PORT is already in use by another process. Stop it, or set PORT=8788 in .env.local and re-run."
  fi
else
  say "Starting local MCP server on port $PORT"
  node dist/http.js &
  SERVER_PID="$!"
  STARTED_SERVER=1
  sleep 1

  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    die "The MCP HTTP server exited immediately. Run 'npm run build' if dist/http.js is missing."
  fi
fi

say "Starting ngrok"
write_connector_file
print_connector_summary
say "Saved connector URL to .ngrok-connector.txt"
ngrok http --url "$BASE" "$PORT" --log stdout --log-format logfmt
