#!/usr/bin/env bash

if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
  TERM_BOLD="$(printf '\033[1m')"
  TERM_DIM="$(printf '\033[2m')"
  TERM_RESET="$(printf '\033[0m')"
  TERM_RED="$(printf '\033[31m')"
  TERM_GREEN="$(printf '\033[32m')"
  TERM_YELLOW="$(printf '\033[33m')"
  TERM_CYAN="$(printf '\033[36m')"
else
  TERM_BOLD=""
  TERM_DIM=""
  TERM_RESET=""
  TERM_RED=""
  TERM_GREEN=""
  TERM_YELLOW=""
  TERM_CYAN=""
fi

term_time() {
  date '+%H:%M:%S'
}

term_banner() {
  local mode="$1"
  local local_url="$2"
  local connector_url="$3"
  local connection_code="${4:-}"

  cat >&2 <<EOF

${TERM_BOLD}LEARN MCP${TERM_RESET} ${TERM_DIM}${mode}${TERM_RESET}
${TERM_DIM}local${TERM_RESET}     ${local_url}
${TERM_DIM}connector${TERM_RESET} ${connector_url}
EOF

  if [ -n "$connection_code" ]; then
    printf '%boath code%b %s\n' "$TERM_DIM" "$TERM_RESET" "$connection_code" >&2
  fi

  cat >&2 <<EOF

${TERM_DIM}time      source      message${TERM_RESET}
EOF
}

term_step() {
  printf '%s  %b%-10s%b %s\n' "$(term_time)" "$TERM_CYAN" "$1" "$TERM_RESET" "$2" >&2
}

term_ok() {
  printf '%s  %b%-10s%b %s\n' "$(term_time)" "$TERM_GREEN" "$1" "$TERM_RESET" "$2" >&2
}

term_warn() {
  printf '%s  %b%-10s%b %s\n' "$(term_time)" "$TERM_YELLOW" "warn" "$TERM_RESET" "$1" >&2
}

term_die() {
  printf '%s  %b%-10s%b %s\n' "$(term_time)" "$TERM_RED" "error" "$TERM_RESET" "$1" >&2
  exit 1
}
