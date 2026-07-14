#!/usr/bin/env bash
# Fires the seance-manifest-updated repository_dispatch to nikrich/poltergeist-plugins.
# Reads the token from SEANCE_DISPATCH_TOKEN (set via the workflow step's env:, not
# interpolated into this script) so the failure path is locally testable.
set -euo pipefail

TARGET_URL="https://api.github.com/repos/nikrich/poltergeist-plugins/dispatches"
MAX_ATTEMPTS=3
RETRY_SLEEP_SECONDS=5

if [ -z "${SEANCE_DISPATCH_TOKEN:-}" ]; then
  echo "::error::SEANCE_DISPATCH_TOKEN secret is missing or empty — set it in the repo secrets"
  exit 1
fi

body_file="$(mktemp)"
trap 'rm -f "$body_file"' EXIT

attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  http_status="$(curl -sS -o "$body_file" -w '%{http_code}' -X POST \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${SEANCE_DISPATCH_TOKEN}" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$TARGET_URL" \
    -d '{"event_type":"seance-manifest-updated"}')"

  if [ "$http_status" -ge 200 ] && [ "$http_status" -lt 300 ]; then
    echo "Dispatch succeeded (HTTP ${http_status})"
    exit 0
  fi

  if [ "$http_status" -ge 500 ] && [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
    echo "Dispatch attempt ${attempt} failed with HTTP ${http_status}; retrying in ${RETRY_SLEEP_SECONDS}s..."
    attempt=$((attempt + 1))
    sleep "$RETRY_SLEEP_SECONDS"
    continue
  fi

  break
done

response_body="$(head -c 500 "$body_file" 2>/dev/null || true)"

if [ "$http_status" = "401" ] || [ "$http_status" = "403" ]; then
  echo "::error::Marketplace dispatch failed: HTTP ${http_status} — SEANCE_DISPATCH_TOKEN is invalid or expired; rotate the SEANCE_DISPATCH_TOKEN secret (see docs/runbooks/seance-dispatch-token-rotation.md)"
else
  echo "::error::Marketplace dispatch failed: HTTP ${http_status} — response: ${response_body}"
fi

exit 1
