#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/.."
stages=0
failed=()
run() { stages=$((stages + 1)); echo "=== [$stages] $1 ==="; shift; "$@" || failed+=("stage $stages"); }
run "eslint"    npx eslint . --max-warnings 0
run "typecheck" npx tsc --noEmit
run "jest"      npx jest --silent
[ ${#failed[@]} -eq 0 ] && { echo "=== verify: all $stages stages passed ==="; exit 0; } || { echo "=== verify: failed: ${failed[*]} ==="; exit 1; }
