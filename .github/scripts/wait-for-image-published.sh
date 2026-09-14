#!/usr/bin/env bash
# Wait until the infrastructure repository_dispatch run for this image+tag+sha
# completes. Fail if that run failed, was cancelled, or does not appear in time.
#
# The product Deploy job stays in progress so a develop→main PR shows the
# live deploy result on the same commit, not only the image push.
#
# Required env: GH_TOKEN, DISPATCH_REPO, GITHUB_SHA, IMAGE, TAG
# Optional: WAIT_TIMEOUT_SEC (default 1200), WAIT_POLL_SEC (default 10)
set -euo pipefail

repo="${DISPATCH_REPO:?DISPATCH_REPO is required}"
sha="${GITHUB_SHA:?GITHUB_SHA is required}"
image="${IMAGE:?IMAGE is required}"
tag="${TAG:?TAG is required}"
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
while [ "$SECONDS" -lt "$deadline" ]; do
  json="$(gh run list --repo "$repo" --event repository_dispatch --limit 30 \
    --json databaseId,displayTitle,status,conclusion,url)"
  selected="$(printf '%s\n' "$json" | jq -c --arg n "$needle" \
    '[.[] | select(.displayTitle | contains($n))] | .[0] // empty')"
  if [ -n "$selected" ]; then
    status="$(printf '%s\n' "$selected" | jq -r '.status')"
    conclusion="$(printf '%s\n' "$selected" | jq -r '.conclusion // ""')"
    run_id="$(printf '%s\n' "$selected" | jq -r '.databaseId')"
    if [ "$status" = "completed" ]; then
      if [ "$conclusion" = "success" ]; then
        echo "Infrastructure deploy succeeded"
        exit 0
      fi
      echo "::error::Infrastructure deploy did not succeed (conclusion=${conclusion})"
      exit 1
    fi
    echo "Infrastructure run ${run_id} is ${status}"
  else
    echo "No matching infrastructure run yet"
  fi
  sleep "$poll_sec"
done

echo "::error::Timed out waiting for infrastructure deploy of this image"
exit 1
