#!/usr/bin/env bash
#
# gifts-debug — operator listing of 21.gifts registered accounts
#               (GET /debug/accounts). Read-only. No raw SQL.
#
# Credentials (never in this script, never printed):
#   ~/.config/21gifts/debug.env  ->  DEBUG_TOKEN, DEBUG_API_URL
#   Override path with GIFTS_DEBUG_ENV.
#
# Usage:
#   gifts-debug auth                 # check token; print account count on stderr
#   gifts-debug accounts [--raw]     # table (default) or JSON
#
# Example:
#   gifts-debug accounts
#   gifts-debug accounts --raw
#
set -euo pipefail

ENV_FILE="${GIFTS_DEBUG_ENV:-$HOME/.config/21gifts/debug.env}"
RAW=0

die() { printf 'gifts-debug: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,/^[^#]/p' "$0" | sed '$d' | sed 's/^#\{1,2\} \{0,1\}//; s/^#$//'
  exit "${1:-0}"
}

read_env_var() {
  local key="$1" file="$2" val
  val=$(awk -v k="$key" 'index($0, k"=")==1 { v=substr($0, length(k)+2) } END { if (v=="") exit 1; print v }' "$file") \
    || die "$key is not set in $file"
  case "$val" in
    \"*\") val="${val#\"}"; val="${val%\"}" ;;
    \'*\') val="${val#\'}"; val="${val%\'}" ;;
  esac
  printf '%s' "$val"
}

[ -f "$ENV_FILE" ] || die "missing $ENV_FILE"
DEBUG_TOKEN=$(read_env_var DEBUG_TOKEN "$ENV_FILE")
DEBUG_API_URL=$(read_env_var DEBUG_API_URL "$ENV_FILE")
DEBUG_API_URL="${DEBUG_API_URL%/}"

fetch_accounts() {
  local tmp status body
  tmp=$(mktemp)
  status=$(curl -sS -o "$tmp" -w '%{http_code}' \
    -H "Authorization: Bearer ${DEBUG_TOKEN}" \
    "${DEBUG_API_URL}/debug/accounts") || {
    rm -f "$tmp"
    die "request failed"
  }
  body=$(cat "$tmp")
  rm -f "$tmp"
  if [ "$status" != "200" ]; then
    die "HTTP ${status}: ${body}"
  fi
  printf '%s' "$body"
}

cmd_auth() {
  local body count
  body=$(fetch_accounts)
  count=$(printf '%s' "$body" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("accounts") or []))')
  printf 'ok (%s accounts)\n' "$count" >&2
}

cmd_accounts() {
  local body
  body=$(fetch_accounts)
  if [ "$RAW" -eq 1 ]; then
    printf '%s\n' "$body"
    return
  fi
  printf '%s' "$body" | python3 -c '
import json, sys
data = json.load(sys.stdin)
rows = data.get("accounts") or []
keys = ["id", "linkingKey", "role", "name", "lightningAddress", "lightningAddressVerified", "createdAt"]
print("\t".join(keys))
for row in rows:
    print("\t".join(str(row.get(k, "")) for k in keys))
print("%s rows" % len(rows), file=sys.stderr)
'
}

ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --raw) RAW=1 ;;
    -h|--help) usage 0 ;;
    --) shift; ARGS+=("$@"); break ;;
    *) ARGS+=("$1") ;;
  esac
  shift
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

case "${1:-}" in
  auth) cmd_auth ;;
  accounts) cmd_accounts ;;
  ""|-h|--help) usage 0 ;;
  *) die "unknown command: $1" ;;
esac
