#!/usr/bin/env bash
#
# Optional: install a macOS LaunchAgent so the HTTP server auto-starts on login
# and is kept alive. Tailscale Funnel persists its own config across reboots, so
# this is the only piece needed for a fully hands-off Tailscale setup. Run:
#   npm run autostart:http
#
# To remove it, the command is printed at the end.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="$(command -v node)" || { echo "node not found on PATH" >&2; exit 1; }
LABEL="com.waterloo-learn.http"
AGENTS="$HOME/Library/LaunchAgents"
PLIST="$AGENTS/$LABEL.plist"
APP_SUPPORT="$HOME/Library/Application Support/waterloo-learn-mcp"
RUNNER="$APP_SUPPORT/run-http.sh"
LOGS="$APP_SUPPORT/logs"
UID_NUM="$(id -u)"

[ -f "$ROOT/dist/http.js" ] || { echo "dist/http.js missing — run 'npm run build' first." >&2; exit 1; }
mkdir -p "$AGENTS" "$APP_SUPPORT" "$LOGS"

cat >"$RUNNER" <<EOF
#!/usr/bin/env bash
set -euo pipefail

export HOME="$HOME"
export PATH="$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cd "$ROOT"
echo "[runner] \$(date '+%Y-%m-%dT%H:%M:%S%z') starting $ROOT/dist/http.js with $NODE"
exec "$NODE" "$ROOT/dist/http.js"
EOF
chmod 700 "$RUNNER"

cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>bash</string>
    <string>$RUNNER</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOGS/http.out.log</string>
  <key>StandardErrorPath</key><string>$LOGS/http.err.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
sleep 1
for attempt in 1 2 3; do
  if launchctl bootstrap "gui/$UID_NUM" "$PLIST"; then
    break
  fi
  if [ "$attempt" = 3 ]; then
    echo "Could not bootstrap LaunchAgent after $attempt attempts." >&2
    exit 1
  fi
  sleep "$attempt"
done
launchctl kickstart -k "gui/$UID_NUM/$LABEL" || true

echo "Installed LaunchAgent: $LABEL"
echo "  The server now auto-starts on login and restarts if it crashes."
echo "  Logs: $LOGS/http.{out,err}.log"
echo "  Token/port are read from .env.local."
echo "  Remove with: launchctl bootout gui/$UID_NUM/$LABEL && rm \"$PLIST\" \"$RUNNER\""
