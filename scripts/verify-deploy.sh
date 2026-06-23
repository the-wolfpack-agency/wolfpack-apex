#!/usr/bin/env bash
# Verify the production alias is serving the CURRENT local commit before we
# trust a live test. A green build does not prove the alias advanced; Vercel
# takes a minute or two to propagate. Polls /api/version until its sha matches
# local HEAD (or times out). Codifies the manual check we kept repeating.
#
# Usage: scripts/verify-deploy.sh [base_url]
set -euo pipefail

BASE="${1:-https://wolfpack-instinct.vercel.app}"
HEAD_SHA="$(git rev-parse HEAD)"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-24}"
SLEEP_SECONDS="${SLEEP_SECONDS:-15}"

echo "Waiting for $BASE to serve $HEAD_SHA ..."
for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  body="$(curl -s --max-time 20 "$BASE/api/version" || true)"
  live_sha="$(printf '%s' "$body" | sed -n 's/.*"sha":"\([a-f0-9]*\)".*/\1/p')"
  if [ "$live_sha" = "$HEAD_SHA" ]; then
    echo "LIVE: $live_sha matches HEAD. Safe to test."
    exit 0
  fi
  echo "attempt $attempt/$MAX_ATTEMPTS: live=${live_sha:-none} head=$HEAD_SHA"
  sleep "$SLEEP_SECONDS"
done

echo "TIMED OUT: production still not serving $HEAD_SHA after $MAX_ATTEMPTS attempts." >&2
exit 1
