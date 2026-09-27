#!/usr/bin/env bash
#
# Verify the Secure Agent PR-gate webhook is deployed and FAIL-CLOSED on the
# given base URL (default: the production deployment). Runnable before any client
# installs the App: it proves the endpoint exists and rejects unauthenticated
# deliveries, which is the security property that matters most for a webhook that
# has no user session. Codifies the check so it is not re-derived by hand.
#
# Usage: scripts/verify-secure-agent-webhook.sh [BASE_URL]
set -euo pipefail

BASE="${1:-https://wolfpack-instinct.vercel.app}"
URL="$BASE/api/github-app/webhook"
fail=0

echo "Verifying Secure Agent webhook fail-closed at: $URL"

# 1) No signature header -> must be 401 (nothing to verify against).
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$URL" \
  -H "content-type: application/json" \
  -H "x-github-event: pull_request" \
  -d '{"action":"opened"}')
if [ "$code" = "401" ]; then
  echo "  PASS  unsigned delivery rejected (401)"
else
  echo "  FAIL  unsigned delivery returned $code (expected 401)"; fail=1
fi

# 2) Wrong signature -> must be 401.
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$URL" \
  -H "content-type: application/json" \
  -H "x-github-event: pull_request" \
  -H "x-hub-signature-256: sha256=deadbeef" \
  -d '{"action":"opened"}')
if [ "$code" = "401" ]; then
  echo "  PASS  wrong-signature delivery rejected (401)"
else
  echo "  FAIL  wrong-signature delivery returned $code (expected 401)"; fail=1
fi

if [ "$fail" = "0" ]; then
  echo "OK: webhook is deployed and fail-closed."
else
  echo "PROBLEM: webhook is not fail-closed (or not deployed). Do NOT go live."; exit 1
fi
