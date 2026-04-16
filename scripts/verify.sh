#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/.."
stages=0
failed=()
run() { stages=$((stages + 1)); echo "=== [$stages] $1 ==="; shift; "$@" || failed+=("stage $stages"); }
run "eslint"    npx eslint . --max-warnings 0
run "typecheck" npx tsc --noEmit
run "jest"      npx jest --silent
# next build catches Next-only errors (mis-ordered "use client" directives,
# server-component / client-component import drift, MDX/font/image misuse)
# that lint + tsc + jest don't see. Skip with VERIFY_SKIP_BUILD=1 for a fast
# inner loop, but pre-push must always run it.
if [ "${VERIFY_SKIP_BUILD:-0}" != "1" ]; then
  run "next build" npx next build
fi
[ ${#failed[@]} -eq 0 ] && { echo "=== verify: all $stages stages passed ==="; exit 0; } || { echo "=== verify: failed: ${failed[*]} ==="; exit 1; }
