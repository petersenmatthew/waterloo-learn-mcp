#!/usr/bin/env bash
#
# Optional: install a macOS LaunchAgent so the HTTP server auto-starts on login
# and is kept alive. Tailscale Funnel persists its own config across reboots, so
# this is the only piece needed for a fully hands-off setup. Run:
#   npm run autostart:chatgpt
#
# To remove it, the command is printed at the end.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="$(command -v node)" || { echo "node not found on PATH" >&2; exit 1; }
LABEL="com.waterloo-learn.http"
AGENTS="$HOME/Library/LaunchAgents"
PLIST="$AGENTS/$LABEL.plist"
UID_NUM="$(id -u)"

[ -f "$ROOT/dist/http.js" ] || { echo "dist/http.js missing — run 'npm run build' first." >&2; exit 1; }
mkdir -p "$AGENTS" "$ROOT/logs"

cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT/dist/http.js</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$ROOT/logs/http.out.log</string>
  <key>StandardErrorPath</key><string>$ROOT/logs/http.err.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
launchctl kickstart -k "gui/$UID_NUM/$LABEL" || true

echo "Installed LaunchAgent: $LABEL"
echo "  The server now auto-starts on login and restarts if it crashes."
echo "  Logs: $ROOT/logs/http.{out,err}.log"
echo "  Token/port are read from .env.local."
echo "  Remove with: launchctl bootout gui/$UID_NUM/$LABEL && rm \"$PLIST\""
