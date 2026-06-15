#!/usr/bin/env bash
#
# Start the saved ngrok tunnel for the HTTP MCP server. Run after first-time
# setup with: npm run start:ngrok
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
ENV_FILE="$ROOT/.env.local"

. "$ROOT/scripts/terminal-ui.sh"
die() { term_die "$*"; }
warn() { term_warn "$*"; }

write_connector_file() {
  cat >"$ROOT/.ngrok-connector.txt" <<EOF
Connector URL: $URL

Add this URL in ChatGPT or Claude.ai:
$URL
EOF
  chmod 600 "$ROOT/.ngrok-connector.txt"
}

check_auth() {
  npm run -s check:auth >/dev/null 2>&1
}

refresh_login() {
  term_step "auth" "opening LEARN login"
  npm run login || die "LEARN login failed or was cancelled"
}

[ -f "$ENV_FILE" ] || die ".env.local is missing. Run: npm run setup:ngrok"

# shellcheck disable=SC1090
set -a; . "$ENV_FILE" 2>/dev/null || true; set +a

PORT="${PORT:-8787}"
MCP_PATH="${LEARN_MCP_PATH:-/mcp}"
DOMAIN="${LEARN_MCP_NGROK_DOMAIN:-${NGROK_DOMAIN:-}}"
DOMAIN="${DOMAIN#http://}"
DOMAIN="${DOMAIN#https://}"
DOMAIN="${DOMAIN%%/*}"

[ -n "$DOMAIN" ] || die "No ngrok domain saved. Run: npm run setup:ngrok"
command -v ngrok >/dev/null 2>&1 || die "ngrok isn't installed. On macOS: brew install ngrok/ngrok/ngrok"

BASE="https://$DOMAIN"
URL="$BASE$MCP_PATH"

term_banner "ngrok" "http://127.0.0.1:$PORT$MCP_PATH" "$URL"

if [ "${LEARN_MCP_SKIP_AUTH_CHECK:-}" != "1" ]; then
  term_step "auth" "checking saved LEARN session"
  if ! check_auth; then
    warn "saved LEARN session is missing or expired"
    refresh_login
    term_step "auth" "checking refreshed LEARN session"
    check_auth || die "LEARN session is still invalid after login"
  fi
  term_ok "auth" "session valid"
fi

cleanup() {
  if [ "${STARTED_SERVER:-0}" = "1" ] && [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  if [ "$(curl -fsS "http://localhost:$PORT/health" 2>/dev/null || true)" = "ok" ]; then
    warn "reusing existing MCP server on port $PORT; activity logs are wherever that server was started"
    STARTED_SERVER=0
  else
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2 || true
    die "Port $PORT is already in use by another process. Stop it, or set PORT=8788 in .env.local and re-run."
  fi
else
  term_step "server" "starting local MCP server on port $PORT"
  LEARN_MCP_PRETTY_LOGS=1 node dist/http.js &
  SERVER_PID="$!"
  STARTED_SERVER=1
  sleep 1

  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    die "The MCP HTTP server exited immediately. Run 'npm run build' if dist/http.js is missing."
  fi
fi

write_connector_file
term_ok "config" "saved connector URL to .ngrok-connector.txt"
term_step "tunnel" "starting ngrok; leave this terminal open"
if [ "${LEARN_MCP_DEBUG:-}" = "1" ]; then
  term_warn "debug logging enabled"
  ngrok http --url "$BASE" "$PORT" --log stdout --log-format logfmt --log-level info
else
  ngrok http --url "$BASE" "$PORT" --log stdout --log-format term --log-level warn
fi
