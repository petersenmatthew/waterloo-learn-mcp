#!/usr/bin/env bash
#
# One-command setup to make waterloo-learn reachable by web chat apps (ChatGPT,
# Claude.ai) via Tailscale Funnel. Run: npm run setup:tailscale
#
# What it does:
#   1. Generates a bearer token (saved to .env.local)
#   2. Builds the server + ensures Playwright Chromium
#   3. Logs you in to LEARN if needed (manual Duo)
#   4. Brings Tailscale up and enables Funnel on your port (stable public URL)
#   5. Prints your connector URL + token + the exact UI steps for each app
#   6. Starts the server in the foreground
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
ENV_FILE="$ROOT/.env.local"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m  %s\n' "$*"; }
die()  { printf '\033[1;31mx\033[0m  %s\n' "$*" >&2; exit 1; }

# --- 1. token + .env.local -------------------------------------------------
if [ ! -f "$ENV_FILE" ]; then
  cp "$ROOT/.env.local.example" "$ENV_FILE" 2>/dev/null || : > "$ENV_FILE"
fi
# shellcheck disable=SC1090
set -a; . "$ENV_FILE" 2>/dev/null || true; set +a
PORT="${PORT:-8787}"

if [ -z "${LEARN_MCP_TOKEN:-}" ]; then
  TOKEN="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9')"
  if grep -q '^LEARN_MCP_TOKEN=' "$ENV_FILE" 2>/dev/null; then
    tmp="$(mktemp)"; sed "s|^LEARN_MCP_TOKEN=.*|LEARN_MCP_TOKEN=$TOKEN|" "$ENV_FILE" >"$tmp" && mv "$tmp" "$ENV_FILE"
  else
    printf 'LEARN_MCP_TOKEN=%s\n' "$TOKEN" >>"$ENV_FILE"
  fi
  LEARN_MCP_TOKEN="$TOKEN"
  say "Generated bearer token (saved to .env.local)"
fi
grep -q '^PORT=' "$ENV_FILE" 2>/dev/null || printf 'PORT=%s\n' "$PORT" >>"$ENV_FILE"

# --- 2. build --------------------------------------------------------------
say "Building"
npm run build >/dev/null
say "Ensuring Playwright Chromium (may download on first run)"
npx playwright install chromium >/dev/null 2>&1 || warn "Could not verify Chromium; run 'npx playwright install chromium' if scraping fails."

# --- 3. LEARN session ------------------------------------------------------
if [ ! -f "$ROOT/auth.json" ]; then
  say "No LEARN session yet — opening a browser. Sign in and approve the Duo push."
  npm run login
fi

# --- 4. Tailscale + Funnel -------------------------------------------------
command -v tailscale >/dev/null 2>&1 || die \
  "Tailscale isn't installed. Get it from https://tailscale.com/download (macOS: 'brew install tailscale' or the App Store app), then re-run."

if ! tailscale status >/dev/null 2>&1; then
  say "Bringing Tailscale up (a login window may open)"
  tailscale up || die "Couldn't bring Tailscale up. Run 'tailscale up' manually, then re-run this."
fi

say "Enabling Tailscale Funnel on port $PORT"
if ! tailscale funnel --bg "$PORT" 2>"$ROOT/.funnel.err"; then
  warn "Funnel didn't start. It usually means Funnel/HTTPS isn't enabled for your tailnet yet."
  warn "Tailscale's output (look for a link to enable it):"
  sed 's/^/    /' "$ROOT/.funnel.err" >&2 || true
  rm -f "$ROOT/.funnel.err"
  die "Enable Funnel + HTTPS in the Tailscale admin console (link above), then re-run."
fi
rm -f "$ROOT/.funnel.err"

DNS="$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)"
[ -n "$DNS" ] || die "Couldn't read your Tailscale device name. Check 'tailscale status'."
BASE="https://$DNS"
URL="$BASE/mcp"
LEGACY_URL="$BASE/mcp/$LEARN_MCP_TOKEN"

# --- 5. instructions -------------------------------------------------------
cat <<EOF

============================================================
$(bold " waterloo-learn is ready for web chat apps")
============================================================

  Connector URL :  $URL
  Authentication:  OAuth / automatic sign-in
  Connection code: $LEARN_MCP_TOKEN

  Same URL works for ChatGPT and Claude.ai. Add it once per app:

  ChatGPT (one time):
    1. Settings → Connectors → Advanced → turn on Developer mode
    2. Add custom connector → Connection: Server URL → paste the URL above
    3. Choose OAuth if prompted; leave manual Client ID/Secret blank
    4. When the authorization page opens, paste the connection code above
    5. Check "I understand and want to continue", click Create
    6. Enable "waterloo-learn" from the tools menu in a chat.

  Claude.ai (one time — no Developer mode needed):
    1. Settings → Connectors  (a.k.a. Customize → Connectors)
    2. Click "+" / Add custom connector
    3. Name it "waterloo-learn", paste the URL above
    4. Leave Advanced settings (OAuth Client ID/Secret) blank, click Add
    5. When the authorization page opens, paste the connection code above
    6. Enable "waterloo-learn" in a chat.

  Treat the connection code like a password — anyone who has it can authorize
  access to your LEARN data. Don't paste it in shared chats or commit it.
  Legacy no-auth URL for clients that cannot do OAuth:
    $LEGACY_URL

  Check it's reachable (from another terminal):
    curl -s $BASE/health        # → ok
    curl -s $BASE/.well-known/oauth-authorization-server | grep registration_endpoint

  The Funnel stays configured across reboots. The server (starting below)
  must be running whenever you want the chat app to reach LEARN.
  To make the server auto-start on login and stay up:
    npm run autostart:http

============================================================

EOF

say "Starting server now — leave this running. Ctrl+C to stop."
exec node dist/http.js
