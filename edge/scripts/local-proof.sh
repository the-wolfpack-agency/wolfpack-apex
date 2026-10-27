#!/usr/bin/env bash
# Forcefield Edge local proof, end to end: start the origin + apex stubs, build
# and start the edge in front of them, run every case, stop everything.
#
#   From the apex repo root:  npm run edge:proof
#   It builds a Next.js app, so on a memory-constrained machine run it under the
#   machine's heavy-check lock (e.g. `serial-check npm run edge:proof`).
#
# Uses only Node + the Next.js already installed for apex. No Docker, no network.
set -u
cd "$(dirname "$0")/.."
EDGE_DIR="$(pwd)"
NEXT_BIN="${NEXT_BIN:-$EDGE_DIR/../node_modules/.bin/next}"
EDGE_PORT="${EDGE_PROOF_EDGE_PORT:-3910}"
export EDGE_PROOF_ORIGIN_PORT="${EDGE_PROOF_ORIGIN_PORT:-3911}"
export EDGE_PROOF_APEX_PORT="${EDGE_PROOF_APEX_PORT:-3912}"
export EDGE_PROOF_EDGE_URL="http://127.0.0.1:${EDGE_PORT}"
# A throwaway token for the stubs only. Never a real credential.
export FORCEFIELD_EDGE_SERVICE_TOKEN="local-proof-service-token-$(node -e 'process.stdout.write(require("crypto").randomBytes(16).toString("hex"))')"

PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
  wait 2>/dev/null
}
trap cleanup EXIT INT TERM

node scripts/local-stubs.mjs &
PIDS+=($!)

if [ "${EDGE_PROOF_SKIP_BUILD:-0}" != "1" ]; then
  # --webpack locally: Turbopack refuses a node_modules symlinked from outside the
  # project root (how apex worktrees share one install). Vercel installs a real
  # node_modules under edge/, so the deployed build is unaffected.
  "$NEXT_BIN" build --webpack || { echo "edge build failed"; exit 1; }
fi

FORCEFIELD_EDGE_SITE_URL="http://127.0.0.1:${EDGE_PROOF_APEX_PORT}/api/forcefield/edge/site" \
FORCEFIELD_INGEST_URL="http://127.0.0.1:${EDGE_PROOF_APEX_PORT}/api/site-analytics/ingest" \
FORCEFIELD_ENFORCE=on \
FORCEFIELD_EDGE_ALLOW_HTTP_ORIGIN=1 \
  "$NEXT_BIN" start -p "$EDGE_PORT" -H 127.0.0.1 &
PIDS+=($!)

for _ in $(seq 1 60); do
  curl -s -o /dev/null "http://127.0.0.1:${EDGE_PORT}/" -H "host: edge-test.local" && break
  sleep 0.5
done

node scripts/local-proof.mjs
status=$?
exit $status
