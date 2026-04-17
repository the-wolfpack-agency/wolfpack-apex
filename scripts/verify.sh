#!/usr/bin/env bash
# Canonical pre-push verifier. Runs lint, typecheck, unit tests, next build,
# and (in CI) the e2e smoke. Each stage reports a [PASS]/[FAIL]/[SKIP] line, and
# a final "verify summary" block lists the per-stage status.
#
# Env knobs:
#   VERIFY_SKIP_BUILD=1  — skip `next build` (fast inner loop)
#   VERIFY_SKIP_E2E=1    — skip the e2e-smoke stage explicitly
#   CI=true              — e2e-smoke only runs in CI; skipped locally otherwise
set -u
cd "$(dirname "$0")/.."

declare -a STAGES
declare -a STATUSES

run_stage() {
  local name="$1"; shift
  STAGES+=("$name")
  echo "=== [${#STAGES[@]}] $name ==="
  if "$@"; then
    STATUSES+=("PASS")
    echo "[PASS] $name"
  else
    STATUSES+=("FAIL")
    echo "[FAIL] $name"
  fi
}

skip_stage() {
  local name="$1" reason="$2"
  STAGES+=("$name")
  STATUSES+=("SKIP")
  echo "[SKIP] $name ($reason)"
}

run_stage "lint"       npm run lint
run_stage "typecheck"  npx tsc --noEmit
run_stage "unit-tests" npx jest --silent

if [ "${VERIFY_SKIP_BUILD:-0}" = "1" ]; then
  skip_stage "next-build" "VERIFY_SKIP_BUILD=1"
else
  run_stage "next-build" npx next build
fi

if [ "${VERIFY_SKIP_E2E:-0}" = "1" ]; then
  skip_stage "e2e-smoke" "VERIFY_SKIP_E2E=1"
elif [ "${CI:-}" != "true" ]; then
  skip_stage "e2e-smoke" "local run — CI only"
else
  run_stage "e2e-smoke" npm run test:e2e:smoke
fi

echo ""
echo "=== verify summary ==="
failed=0
for i in "${!STAGES[@]}"; do
  status="${STATUSES[$i]}"
  echo "  [${status}] ${STAGES[$i]}"
  [ "$status" = "FAIL" ] && failed=$((failed + 1))
done

if [ "$failed" -eq 0 ]; then
  echo "=== verify: all ${#STAGES[@]} stages ok ==="
  exit 0
else
  echo "=== verify: $failed stage(s) failed ==="
  exit 1
fi
