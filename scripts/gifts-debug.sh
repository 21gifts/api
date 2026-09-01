#!/usr/bin/env bash
#
# gifts-debug — operator listing, role assignment, Lightning Address unlink,
#               and forum-video restore for 21.gifts
#               (GET /debug/accounts, PATCH /debug/accounts/:id,
#               PUT /debug/messages/:id/video). No raw SQL.
#
# Credentials (never in this script, never printed):
#   ~/.config/21gifts/debug.env  ->  DEBUG_TOKEN, DEBUG_API_URL
#   Override path with GIFTS_DEBUG_ENV.
#
# Usage:
#   gifts-debug auth                 # check token; print account count on stderr
#   gifts-debug accounts [--raw]     # table (default) or JSON
#   gifts-debug role <id> <role>     # set account.role; print updated account JSON
#   gifts-debug unlink <id>          # hard-delete Lightning Address; print updated account JSON
#   gifts-debug video-put <id> <file>  # PUT video bytes for message id; 204 on success
#
# Example:
#   gifts-debug accounts
#   gifts-debug accounts --raw
#   gifts-debug role <account-id> moderator
#   gifts-debug unlink <account-id>
#   gifts-debug video-put <message-id> ./clip.mp4
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

cmd_role() {
  local id="${1:-}" role="${2:-}" tmp status body
  [ -n "$id" ] || die "usage: gifts-debug role <account-id> <role>"
  [ -n "$role" ] || die "usage: gifts-debug role <account-id> <role>"
  tmp=$(mktemp)
  status=$(curl -sS -o "$tmp" -w '%{http_code}' \
    -X PATCH \
    -H "Authorization: Bearer ${DEBUG_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"role\":\"${role}\"}" \
    "${DEBUG_API_URL}/debug/accounts/${id}") || {
    rm -f "$tmp"
    die "request failed"
  }
  body=$(cat "$tmp")
  rm -f "$tmp"
  if [ "$status" != "200" ]; then
    die "HTTP ${status}: ${body}"
  fi
  printf '%s\n' "$body"
}

cmd_unlink() {
  local id="${1:-}" tmp status body
  [ -n "$id" ] || die "usage: gifts-debug unlink <account-id>"
  tmp=$(mktemp)
  status=$(curl -sS -o "$tmp" -w '%{http_code}' \
    -X PATCH \
    -H "Authorization: Bearer ${DEBUG_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"lightningAddress":null}' \
    "${DEBUG_API_URL}/debug/accounts/${id}") || {
    rm -f "$tmp"
    die "request failed"
  }
  body=$(cat "$tmp")
  rm -f "$tmp"
  if [ "$status" != "200" ]; then
    die "HTTP ${status}: ${body}"
  fi
  printf '%s\n' "$body"
}

cmd_video_put() {
  local id="${1:-}" path="${2:-}" tmp status body
  [ -n "$id" ] || die "usage: gifts-debug video-put <message-id> <file>"
  [ -n "$path" ] || die "usage: gifts-debug video-put <message-id> <file>"
  [ -f "$path" ] || die "file not found: ${path}"
  tmp=$(mktemp)
  status=$(curl -sS -o "$tmp" -w '%{http_code}' \
    -X PUT \
    -H "Authorization: Bearer ${DEBUG_TOKEN}" \
    --data-binary @"${path}" \
    "${DEBUG_API_URL}/debug/messages/${id}/video") || {
    rm -f "$tmp"
    die "request failed"
  }
  body=$(cat "$tmp")
  rm -f "$tmp"
  printf '%s\n' "$status" >&2
  if [ "$status" != "204" ]; then
    die "HTTP ${status}: ${body}"
  fi
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
  role) shift; cmd_role "$@" ;;
  unlink) shift; cmd_unlink "$@" ;;
  video-put) shift; cmd_video_put "$@" ;;
  ""|-h|--help) usage 0 ;;
  *) die "unknown command: $1" ;;
esac
