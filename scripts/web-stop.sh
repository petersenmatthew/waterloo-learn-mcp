#!/usr/bin/env bash
#
# Stop the web MCP HTTP server and unload its LaunchAgent if installed.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.waterloo-learn.http"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
RUNNER="$HOME/Library/Application Support/waterloo-learn-mcp/run-http.sh"
UID_NUM="$(id -u)"

launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true

if [ -f "$PLIST" ]; then
  rm "$PLIST"
fi

if [ -f "$RUNNER" ]; then
  rm "$RUNNER"
fi

PID="$(lsof -tiTCP:8787 -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$PID" ]; then
  CMD="$(ps -p "$PID" -o command= 2>/dev/null || true)"
  case "$CMD" in
    *"$ROOT/dist/http.js"*)
      kill "$PID"
      ;;
    *)
      echo "Port 8787 is in use by another process; leaving it alone:"
      echo "  $CMD"
      ;;
  esac
fi

echo "Stopped web MCP server autostart."
