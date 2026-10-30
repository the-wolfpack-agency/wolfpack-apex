#!/usr/bin/env bash
# The CI "Static Security Scan" gate, run locally before pushing: the AgenticQA
# client scan, then the same baseline comparison CI uses
# (scripts/security/self-scan.ts static vs .agenticqa/scan-baseline.json).
# CI prints no findings (this repository's logs are public); locally the report
# names each NEW finding so it can be fixed (or marked PUBLIC: <reason> when a
# route is public by design) before CI spends a run on it.
#
# Usage: npm run security:static-local
# Env:   AGENTICQA_DIR (default ../AgenticQA), a read-only checkout of the tool.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TOOL="${AGENTICQA_DIR:-$ROOT/../AgenticQA}"
if [ ! -f "$TOOL/scripts/run_client_scan.py" ]; then
  echo "static-scan-local: no AgenticQA checkout at $TOOL (set AGENTICQA_DIR); skipped, CI still gates."
  exit 0
fi
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
python3 "$TOOL/scripts/run_client_scan.py" "$ROOT" --output "$OUT/scan-results.json" > /dev/null 2> "$OUT/scan-stderr.log" || {
  echo "static-scan-local: the scan failed"; tail -n 20 "$OUT/scan-stderr.log"; exit 2;
}
cd "$ROOT"
SECURITY_REPORT_PUBLIC=false npx tsx scripts/security/self-scan.ts static --scan "$OUT/scan-results.json" --baseline .agenticqa/scan-baseline.json --md "$OUT/scan-report.md"
