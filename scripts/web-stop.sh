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
  # The LaunchAgent invokes the server by absolute path; a manual
  # `npm run start:http` shows the relative "node dist/http.js", so also
  # accept that when the process's cwd is this project.
  PID_CWD="$(lsof -a -p "$PID" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
  case "$CMD" in
    *"$ROOT/dist/http.js"*)
      kill "$PID"
      ;;
    *dist/http.js*)
      if [ "$PID_CWD" = "$ROOT" ]; then
        kill "$PID"
      else
        echo "Port 8787 is in use by another process; leaving it alone:"
        echo "  $CMD"
      fi
      ;;
    *)
      echo "Port 8787 is in use by another process; leaving it alone:"
      echo "  $CMD"
      ;;
  esac
fi

echo "Stopped web MCP server autostart."
