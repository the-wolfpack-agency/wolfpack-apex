#!/usr/bin/env bash
# Prove a deployment is configured + its backing services are reachable BEFORE it
# goes live, so it never crash-loops or silently half-works from a missing env var
# or a down store. Codifies the manual onboarding check (the DRY counterpart to
# verify-deploy.sh, which only checks the served commit sha).
#
# Two modes:
#   1. Live endpoint (default): curls GET /api/admin/deployment-readiness on a
#      deployed URL and exits non-zero if any CRITICAL check fails. The route is
#      capability-gated (settings.manage_team), so pass an access token via
#      $READINESS_TOKEN (Bearer) for a real deployment.
#   2. Local lib (--local): runs runDeploymentReadiness against the CURRENT
#      process.env via a node one-liner — no server needed. Use this in CI right
#      after `vercel env pull` to gate a deploy on the env being complete.
#
# Never prints secret VALUES: only check names + pass/fail + the readiness verdict.
#
# Usage:
#   scripts/verify-prod-env.sh [base_url]        # live endpoint mode
#   READINESS_TOKEN=<jwt> scripts/verify-prod-env.sh https://wolfpack-instinct.vercel.app
#   scripts/verify-prod-env.sh --local           # run the lib against local env
set -euo pipefail

MODE="live"
BASE="https://wolfpack-instinct.vercel.app"

for arg in "$@"; do
  case "$arg" in
    --local) MODE="local" ;;
    http://*|https://*) BASE="$arg" ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [ "$MODE" = "local" ]; then
  echo "Running deployment readiness against the local environment ..."
  # Run the lib through tsx (TypeScript ESM loader, already a dev dependency) via
  # a tiny temp ESM module — tsx --eval defaults to CJS, which rejects top-level
  # await, so a real .mjs file is the portable path. Connectivity pingers are
  # intentionally omitted in --local mode: this gate proves ENV completeness
  # pre-deploy, when services may not be reachable from the CI runner. Use live
  # mode post-deploy for connectivity.
  # Resolve the repo root from this script's location so the lib import + tsx run
  # from a stable cwd regardless of where the script was invoked. The shim lives
  # in the repo (fixed .mjs extension — node's ESM loader keys on it) and is
  # cleaned up on exit.
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  SHIM="$REPO_ROOT/.readiness-shim.mjs"
  trap 'rm -f "$SHIM"' EXIT
  cat > "$SHIM" <<'EOF'
import { runDeploymentReadiness } from "./src/lib/deploy/deployment-readiness.ts";
const result = await runDeploymentReadiness({});
for (const c of result.checks) {
  const tag = c.pass ? "PASS" : (c.critical ? "FAIL" : "WARN");
  console.log(`${tag}  ${c.name}: ${c.detail}`);
}
if (!result.ok) {
  console.error("NOT READY: a critical env check failed.");
  process.exit(1);
}
console.log("READY: every critical env check passed.");
EOF
  ( cd "$REPO_ROOT" && npx --no-install tsx "$SHIM" )
  exit $?
fi

echo "Checking deployment readiness at $BASE ..."

AUTH_HEADER=()
if [ -n "${READINESS_TOKEN:-}" ]; then
  AUTH_HEADER=(-H "Authorization: Bearer ${READINESS_TOKEN}")
fi

http_code="$(curl -s -o /tmp/readiness_body.json -w '%{http_code}' --max-time 30 \
  "${AUTH_HEADER[@]}" "$BASE/api/admin/deployment-readiness" || true)"

if [ "$http_code" = "401" ] || [ "$http_code" = "403" ]; then
  echo "AUTH REQUIRED ($http_code): set READINESS_TOKEN to a token with settings.manage_team." >&2
  exit 1
fi
if [ "$http_code" != "200" ]; then
  echo "UNEXPECTED HTTP $http_code from the readiness endpoint." >&2
  cat /tmp/readiness_body.json >&2 || true
  exit 1
fi

# Parse the result. jq is in CI; fall back to node if it isn't.
if command -v jq >/dev/null 2>&1; then
  jq -r '.checks[] | (if .pass then "PASS" elif .critical then "FAIL" else "WARN" end) + "  " + .name + ": " + .detail' /tmp/readiness_body.json
  OK="$(jq -r '.ok' /tmp/readiness_body.json)"
else
  OK="$(node -e 'const r=require("/tmp/readiness_body.json");for(const c of r.checks){console.log((c.pass?"PASS":(c.critical?"FAIL":"WARN"))+"  "+c.name+": "+c.detail)}process.stdout.write(String(r.ok))')"
fi

if [ "$OK" != "true" ]; then
  echo "NOT READY: a critical check failed. Do NOT go live until fixed." >&2
  exit 1
fi

echo "READY: every critical check passed. Safe to go live."
exit 0
