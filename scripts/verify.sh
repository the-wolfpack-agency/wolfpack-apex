#!/usr/bin/env bash
# Canonical pre-push verifier. Runs lint, typecheck, unit tests, next build,
# and (in CI) the e2e smoke. Each stage reports a [PASS]/[FAIL]/[SKIP] line, and
# a final "verify summary" block lists the per-stage status.
#
# Env knobs:
#   VERIFY_SKIP_BUILD=1   - skip `next build` (fast inner loop)
#   VERIFY_SKIP_BRANCH=1  - skip the branch-base advisory (see below)
#   VERIFY_SKIP_E2E=1     - skip the e2e-smoke + qr-download stages explicitly
#   CI=true               - e2e-smoke only runs in CI; skipped locally otherwise
#
#   VERIFY_STAGES=<csv>   - select which stage GROUPS run. Default (unset) runs
#                           every stage exactly as before, so a plain
#                           `npm run verify` is byte-for-byte unchanged. CI fans
#                           the work across parallel jobs by setting this:
#                             typecheck  -> tsc
#                             lint       -> eslint
#                             unit       -> jest (the heavy stage; shardable)
#                             e2e        -> qr-download + next-build + e2e-smoke
#                           Comma-combine freely, e.g. "typecheck,lint".
#   JEST_SHARD=<i/n>      - when set, the unit jest run adds --shard=$JEST_SHARD
#                           so CI can split the ~13k-test suite across runners.
#   JEST_WORKERS=<spec>   - maxWorkers for jest. Default 50%: the documented CI
#                           sweet spot - enough parallelism to be fast, few
#                           enough workers that they don't thrash a 2-core
#                           runner. (Local default also 50%, harmless.)
#   JEST_JSON=<path>      - where to write jest's machine-readable run summary
#                           (default jest-results.json). Uses jest's BUILT-IN
#                           --json reporter; no extra dependency.
#   VERIFY_DRY_RUN=1      - print the resolved plan (ordered stages + shard +
#                           workers) and exit 0 without running anything. Lets
#                           the stage/shard logic be unit-tested cheaply.
set -u
cd "$(dirname "$0")/.."

# --- resolve the plan -------------------------------------------------------
JEST_WORKERS="${JEST_WORKERS:-50%}"
JEST_JSON="${JEST_JSON:-jest-results.json}"

# stage_enabled <group>: true when VERIFY_STAGES is unset (run all) or lists it.
stage_enabled() {
  local group="$1"
  [ -z "${VERIFY_STAGES:-}" ] && return 0
  case ",${VERIFY_STAGES}," in
    *",${group},"*) return 0 ;;
    *) return 1 ;;
  esac
}

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

# The unit jest invocation, built once so the dry-run plan and the real run
# can never drift. --workerIdleMemoryLimit recycles bloated workers (the
# GC-stall flake fix, mirrored in jest.config.ts). --json + --outputFile use
# jest's built-in reporter for artifact capture (no dependency).
build_jest_cmd() {
  JEST_CMD=(npx jest --silent
    --maxWorkers="${JEST_WORKERS}"
    --workerIdleMemoryLimit=512MB
    --json --outputFile="${JEST_JSON}")
  if [ -n "${JEST_SHARD:-}" ]; then
    JEST_CMD+=(--shard="${JEST_SHARD}")
  fi
}
build_jest_cmd

run_unit_tests() { "${JEST_CMD[@]}"; }

# `--experimental-vm-modules` lets the export-pdf renderer's lazy
# dynamic import of @react-pdf/renderer (ESM-only) load inside Jest's
# sandboxed VM. Production (Node 20 on Vercel) doesn't need this flag -
# only Jest's module registry does.
export NODE_OPTIONS="${NODE_OPTIONS:-} --experimental-vm-modules"

# --- dry run: print the plan and exit --------------------------------------
if [ "${VERIFY_DRY_RUN:-0}" = "1" ]; then
  echo "=== verify plan ==="
  echo "  jest-workers: ${JEST_WORKERS}"
  echo "  jest-shard:   ${JEST_SHARD:-none}"
  echo "  jest-json:    ${JEST_JSON}"
  echo "  stages-filter: ${VERIFY_STAGES:-all}"
  echo "  ordered-stages:"
  stage_enabled lint      && echo "    - lint"
  stage_enabled typecheck && echo "    - typecheck"
  stage_enabled unit      && echo "    - unit-tests (${JEST_CMD[*]})"
  if [ "${VERIFY_SKIP_E2E:-0}" != "1" ]; then
    stage_enabled e2e && echo "    - qr-download-decode"
  fi
  if [ "${VERIFY_SKIP_BUILD:-0}" != "1" ]; then
    stage_enabled e2e && echo "    - next-build"
  fi
  if [ "${VERIFY_SKIP_E2E:-0}" != "1" ]; then
    stage_enabled e2e && echo "    - smoke-self-check"
  fi
  if [ "${VERIFY_SKIP_E2E:-0}" != "1" ] && [ "${VERIFY_SKIP_SMOKE:-0}" != "1" ] && [ "${CI:-}" = "true" ]; then
    stage_enabled e2e && echo "    - e2e-smoke"
  fi
  exit 0
fi

# --- run the selected stages -----------------------------------------------
# Branch hygiene first, because it is the cheapest stage and the one whose
# failure wastes the most: this repo squash-merges, so a branch that still holds
# its own already-merged commits produces a conflicted PR, and work stacked onto
# a branch whose PR merges first is silently orphaned. Both cost a session
# before this existed. ADVISORY: it prints and moves on, never failing a push,
# because a false positive here must not stop someone shipping.
if [ "${VERIFY_SKIP_BRANCH:-0}" != "1" ] && [ "${CI:-}" != "true" ]; then
  npx tsx scripts/check-branch-base.ts || true
fi

stage_enabled lint      && run_stage "lint"       npm run lint
# Structural, and costs milliseconds: an unbounded CI job is a six-hour hang
# waiting to happen, and the only symptom is a check that never finishes.
stage_enabled lint      && run_stage "ci-timeouts" npm run ci:check-timeouts
stage_enabled typecheck && run_stage "typecheck"  npx tsc --noEmit
stage_enabled unit      && run_stage "unit-tests" run_unit_tests

# Real-browser guard for the QR download rasterizer (no dev server/DB).
# Catches the "svg image decode failed" duplicate-attribute regression
# that jsdom cannot - SVG <img> decode + canvas.toBlob need a real engine.
if stage_enabled e2e; then
  if [ "${VERIFY_SKIP_E2E:-0}" = "1" ]; then
    skip_stage "qr-download-decode" "VERIFY_SKIP_E2E=1"
  else
    run_stage "qr-download-decode" npm run test:qr-download
    # Fixture-in/verdict-out guard for the spec-diff measurement chain. Same
    # posture as the QR decode guard above: a real browser, no dev server, no
    # DB. It is the only test that proves the probes read a real DOM correctly;
    # jsdom has no layout engine, so every box there measures 0x0 and an
    # assertion about a 66px header would pass for the wrong reason.
    run_stage "spec-diff-fidelity" npm run test:spec-diff
  fi

  if [ "${VERIFY_SKIP_BUILD:-0}" = "1" ]; then
    skip_stage "next-build" "VERIFY_SKIP_BUILD=1"
  else
    run_stage "next-build" npx next build
  fi

  # THE SMOKE'S OWN GUARDRAIL, and it runs where the smoke does not.
  #
  # e2e-smoke is CI-only and post-merge-only, so from 2026-06-28 to 2026-08-24
  # it failed on main while every PR went green and every local verify printed
  # 8/8. This spec serves its own pages over localhost, needs no deployment and
  # no credentials, and pins the probe timing that broke. It runs on PRs and
  # locally, which is precisely where the bug was invisible.
  if [ "${VERIFY_SKIP_E2E:-0}" = "1" ]; then
    skip_stage "smoke-self-check" "VERIFY_SKIP_E2E=1"
  else
    run_stage "smoke-self-check" npm run test:e2e:smoke-self-check
  fi

  # The e2e-smoke probes the DEPLOYED prod URL (PROD_URL). That is a post-merge
  # "verify on the deployed URL" check, not a PR gate: a PR cannot fix prod state,
  # and the PR's own code is already gated by lint + unit shards + next-build +
  # qr-download. So VERIFY_SKIP_SMOKE=1 (set for pull_request events in verify.yml)
  # skips it on PRs; it still runs on push to main against the freshly deployed prod.
  if [ "${VERIFY_SKIP_E2E:-0}" = "1" ]; then
    skip_stage "e2e-smoke" "VERIFY_SKIP_E2E=1"
  elif [ "${VERIFY_SKIP_SMOKE:-0}" = "1" ]; then
    skip_stage "e2e-smoke" "deployed-URL smoke runs post-merge, not on PRs"
  elif [ "${CI:-}" != "true" ]; then
    skip_stage "e2e-smoke" "local run - CI only"
  else
    run_stage "e2e-smoke" npm run test:e2e:smoke
  fi
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
