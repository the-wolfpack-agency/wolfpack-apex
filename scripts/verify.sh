#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# Local verification gate: lint → typecheck → unit tests → e2e smoke.
#
# Exits non-zero if any stage fails, but records every stage's result and
# prints a summary at the end. In CI this script is the contract enforced by
# .github/workflows/verify.yml.
#
# Portable across bash 3 (macOS default) and bash 4+ (Linux/CI): uses parallel
# arrays, not associative arrays.
#
# Env:
#   CI=true             Running in CI. Skips e2e smoke unless PROD_URL is set,
#                       since CI runners without a deployed target should not
#                       waste minutes spinning up a dev server here.
#   PROD_URL=...        Target the Playwright smoke at a deployed URL.
#   VERIFY_SKIP_E2E=1   Force-skip the e2e smoke (e.g. during infra churn).
# ----------------------------------------------------------------------------
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

start_ts=$(date +%s)

STAGE_NAMES=()
STAGE_RESULTS=()
STAGE_DURATIONS=()

record() {
  STAGE_NAMES+=("$1")
  STAGE_RESULTS+=("$2")
  STAGE_DURATIONS+=("$3")
}

run_stage() {
  local name="$1"
  shift
  local stage_start
  stage_start=$(date +%s)
  echo ""
  echo "──────────────────────────────────────────────────"
  echo "▶ $name"
  echo "──────────────────────────────────────────────────"
  if "$@"; then
    record "$name" "pass" $(( $(date +%s) - stage_start ))
  else
    record "$name" "fail" $(( $(date +%s) - stage_start ))
  fi
}

skip_stage() {
  local name="$1"
  local reason="$2"
  echo ""
  echo "──────────────────────────────────────────────────"
  echo "▶ $name (skipped: $reason)"
  echo "──────────────────────────────────────────────────"
  record "$name" "skip" 0
}

# ---------------------------------------------------------------------------
# Stages
# ---------------------------------------------------------------------------

run_stage "lint" npm run lint --silent
run_stage "typecheck" npx tsc --noEmit
run_stage "unit-tests" npx jest --silent --passWithNoTests

if [[ "${VERIFY_SKIP_E2E:-0}" == "1" ]]; then
  skip_stage "e2e-smoke" "VERIFY_SKIP_E2E=1"
elif [[ "${CI:-false}" == "true" && -z "${PROD_URL:-}" ]]; then
  skip_stage "e2e-smoke" "CI=true without PROD_URL"
else
  run_stage "e2e-smoke" npm run test:e2e:smoke --silent
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
total=$(( $(date +%s) - start_ts ))
echo ""
echo "=================================================="
echo "verify summary (total ${total}s)"
echo "=================================================="
any_failed=0
for i in "${!STAGE_NAMES[@]}"; do
  name="${STAGE_NAMES[$i]}"
  result="${STAGE_RESULTS[$i]}"
  dur="${STAGE_DURATIONS[$i]}"
  case "$result" in
    pass) marker="PASS" ;;
    fail) marker="FAIL"; any_failed=1 ;;
    skip) marker="SKIP" ;;
    *)    marker="????" ;;
  esac
  printf "  [%s] %-14s %ss\n" "$marker" "$name" "$dur"
done
echo "=================================================="

exit "$any_failed"
