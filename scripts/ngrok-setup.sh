#!/usr/bin/env bash
#
# One-command setup to make waterloo-learn reachable by web chat apps (ChatGPT,
# Claude.ai) via ngrok. Run: npm run setup:ngrok
#
# What it does:
#   1. Generates a bearer token (saved to .env.local)
#   2. Saves your ngrok domain (LEARN_MCP_NGROK_DOMAIN in .env.local)
#   3. Builds the server + ensures Playwright Chromium
#   4. Logs you in to LEARN if needed (manual Duo)
#   5. Starts the local HTTP server and ngrok tunnel
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
ENV_FILE="$ROOT/.env.local"

. "$ROOT/scripts/terminal-ui.sh"
say()  { term_step "setup" "$*"; }
warn() { term_warn "$*"; }
die()  { term_die "$*"; }

save_env_var() {
  local key="$1"
  local value="$2"
  local tmp

  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    tmp="$(mktemp)"
    sed "s|^${key}=.*|${key}=${value}|" "$ENV_FILE" >"$tmp" && mv "$tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  fi
}

normalize_domain() {
  local value="$1"
  value="${value#http://}"
  value="${value#https://}"
  value="${value%%/*}"
  printf '%s' "$value"
}

write_connector_file() {
  cat >"$ROOT/.ngrok-connector.txt" <<EOF
Connector URL: $URL
Connection code: $LEARN_MCP_TOKEN

Add this URL in ChatGPT or Claude.ai:
$URL

Use OAuth if prompted. Leave Client ID and Client Secret blank.
When the authorization page opens, paste the connection code above.

Legacy no-auth URL for clients that cannot use OAuth:
$LEGACY_URL
EOF
  chmod 600 "$ROOT/.ngrok-connector.txt"
}

# --- 1. token + .env.local -------------------------------------------------
if [ ! -f "$ENV_FILE" ]; then
  cp "$ROOT/.env.local.example" "$ENV_FILE" 2>/dev/null || : > "$ENV_FILE"
fi

# shellcheck disable=SC1090
set -a; . "$ENV_FILE" 2>/dev/null || true; set +a
PORT="${PORT:-8787}"
MCP_PATH="${LEARN_MCP_PATH:-/mcp}"

if [ -z "${LEARN_MCP_TOKEN:-}" ]; then
  TOKEN="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9')"
  save_env_var "LEARN_MCP_TOKEN" "$TOKEN"
  LEARN_MCP_TOKEN="$TOKEN"
  say "Generated bearer token (saved to .env.local)"
fi
grep -q '^PORT=' "$ENV_FILE" 2>/dev/null || printf 'PORT=%s\n' "$PORT" >>"$ENV_FILE"

# --- 2. ngrok domain -------------------------------------------------------
DOMAIN_INPUT="${1:-${LEARN_MCP_NGROK_DOMAIN:-${NGROK_DOMAIN:-}}}"

if [ -z "$DOMAIN_INPUT" ]; then
  cat <<EOF

Find your free ngrok dev domain here:
  https://dashboard.ngrok.com/domains

It usually looks like:
  something.ngrok-free.app

EOF
  printf 'Paste your ngrok domain: '
  read -r DOMAIN_INPUT
fi

DOMAIN="$(normalize_domain "$DOMAIN_INPUT")"
[ -n "$DOMAIN" ] || die "No ngrok domain provided."
save_env_var "LEARN_MCP_NGROK_DOMAIN" "$DOMAIN"

# --- 3. prerequisites ------------------------------------------------------
command -v ngrok >/dev/null 2>&1 || die \
  "ngrok isn't installed. On macOS: brew install ngrok/ngrok/ngrok"

if ! ngrok config check >/dev/null 2>&1; then
  die "ngrok is not logged in. Run: ngrok config add-authtoken <token from https://dashboard.ngrok.com/get-started/your-authtoken>"
fi

say "Building"
npm run build >/dev/null
say "Ensuring Playwright Chromium (may download on first run)"
npx playwright install chromium >/dev/null 2>&1 || warn "Could not verify Chromium; run 'npx playwright install chromium' if scraping fails."

# --- 4. LEARN session ------------------------------------------------------
if [ ! -f "$ROOT/auth.json" ]; then
  say "No LEARN session yet — opening a browser. Sign in and approve the Duo push."
  npm run login
fi
if [ "${LEARN_MCP_SKIP_AUTH_CHECK:-}" != "1" ]; then
  term_step "auth" "checking saved LEARN session"
  AUTH_OUTPUT="$(npm run -s check:auth 2>&1)" || {
    printf '%s\n' "$AUTH_OUTPUT" >&2
    die "LEARN session check failed. If the network is fine, run: npm run login"
  }
  term_ok "auth" "session valid"
fi

BASE="https://$DOMAIN"
URL="$BASE$MCP_PATH"
LEGACY_URL="$BASE$MCP_PATH/$LEARN_MCP_TOKEN"

# --- 5. instructions -------------------------------------------------------
term_banner "ngrok setup" "http://127.0.0.1:$PORT$MCP_PATH" "$URL" "$LEARN_MCP_TOKEN"
term_step "oauth" "use OAuth; leave manual Client ID and Client Secret blank"

cleanup() {
  if [ "${STARTED_SERVER:-0}" = "1" ] && [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  if [ "$(curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null || true)" = "ok" ]; then
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
    die "The MCP HTTP server exited immediately. Port $PORT may already be in use."
  fi
fi

write_connector_file
term_ok "config" "saved connector details to .ngrok-connector.txt"
term_step "tunnel" "starting ngrok; leave this terminal open"
if [ "${LEARN_MCP_DEBUG:-}" = "1" ]; then
  term_warn "debug logging enabled"
  ngrok http --url "$BASE" "$PORT" --log stdout --log-format logfmt --log-level info
else
  ngrok http --url "$BASE" "$PORT" --log stdout --log-format term --log-level warn
fi
