#!/usr/bin/env bash
# Wait until the infrastructure repository_dispatch run for this image+tag+sha
# completes successfully. A cancelled run is not a product failure: two image
# publishes can overlap and GitHub then cancels one host job. Re-dispatch once
# and keep polling for a successful run of the same image:tag:sha.
#
# The product Deploy job stays in progress so a develop→main PR shows the
# live deploy result on the same commit, not only the image push.
#
# Required env: GH_TOKEN, DISPATCH_REPO, GITHUB_SHA, IMAGE, TAG, DISPATCHED_AT
# Optional: WAIT_TIMEOUT_SEC (default 1200), WAIT_POLL_SEC (default 10)
set -euo pipefail

repo="${DISPATCH_REPO:?DISPATCH_REPO is required}"
sha="${GITHUB_SHA:?GITHUB_SHA is required}"
image="${IMAGE:?IMAGE is required}"
tag="${TAG:?TAG is required}"
dispatched_at="${DISPATCHED_AT:?DISPATCHED_AT is required}"
timeout_sec="${WAIT_TIMEOUT_SEC:-1200}"
poll_sec="${WAIT_POLL_SEC:-10}"

if [ "${#sha}" -ne 40 ]; then
  echo "::error::GITHUB_SHA must be a 40-character commit SHA"
  exit 1
fi

needle="image-published ${image}:${tag} ${sha}"
echo "Waiting for infrastructure run titled: ${needle}"

deadline=$((SECONDS + timeout_sec))
run_id=""
redispatched=0

find_run() {
  json="$(gh run list --repo "$repo" --event repository_dispatch --limit 30 \
    --json databaseId,displayTitle,status,conclusion,createdAt)"
  printf '%s\n' "$json" | jq -r --arg n "$needle" --arg t "$dispatched_at" \
    '[.[] | select(.displayTitle == $n and .createdAt >= $t)]
     | sort_by(.createdAt) | reverse | .[0].databaseId // empty'
}

poll_run() {
  gh run view "$run_id" --repo "$repo" --json status,conclusion
}

redispatch() {
  echo "Re-dispatching image-published ${image}:${tag} ${sha}"
  gh api "repos/${repo}/dispatches" \
    -f event_type=image-published \
    -f "client_payload[image]=${image}" \
    -f "client_payload[tag]=${tag}" \
    -f "client_payload[sha]=${sha}"
  dispatched_at="$(date -u -d '5 seconds ago' +%Y-%m-%dT%H:%M:%SZ)"
  redispatched=1
  run_id=""
}

while [ "$SECONDS" -lt "$deadline" ]; do
  if [ -z "$run_id" ]; then
    run_id="$(find_run)"
    if [ -z "$run_id" ]; then
      echo "No matching infrastructure run yet"
      sleep "$poll_sec"
      continue
    fi
    echo "Pinned infrastructure run ${run_id}"
  fi
  view="$(poll_run)"
  status="$(printf '%s\n' "$view" | jq -r '.status')"
  conclusion="$(printf '%s\n' "$view" | jq -r '.conclusion // ""')"
  if [ "$status" = "completed" ]; then
    if [ "$conclusion" = "success" ]; then
      echo "Infrastructure deploy succeeded"
      exit 0
    fi
    echo "Infrastructure run ${run_id} ended (${conclusion})"
    if [ "$conclusion" = "cancelled" ] && [ "$redispatched" -eq 0 ]; then
      redispatch
      sleep "$poll_sec"
      continue
    fi
    echo "::error::Infrastructure deploy did not succeed (conclusion=${conclusion})"
    exit 1
  fi
  echo "Infrastructure run ${run_id} is ${status}"
  sleep "$poll_sec"
done

echo "::error::Timed out waiting for infrastructure deploy of this image"
exit 1
