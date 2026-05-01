#!/usr/bin/env bash
# Audit all "apex" references in the repo, bucketed by safety class.
# Run from repo root: bash scripts/audit-apex-refs.sh
#
# Buckets:
#   IMMUTABLE       — never touch (SQL migration history, sealed handoff docs)
#   ACTIVE-SCHEMA   — apex_* table references in live source code (hit compat views)
#   ACTIVE-TYPE     — Apex/APEX in TypeScript types, configs, package metadata
#   COSMETIC        — comments, strings, doc references (low risk)
#
# Outputs counts + a per-bucket file list. macOS bash 3.2 compatible.

set -uo pipefail

cd "$(dirname "$0")/.."

EXCLUDES=(--exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git --exclude-dir=dist --exclude-dir=.vercel --exclude-dir=.claude --exclude-dir=.agenticqa --exclude-dir=.ai)

OUT_DIR=$(mktemp -d)
trap 'rm -rf "$OUT_DIR"' EXIT

# IMMUTABLE: SQL migration files + dated handoff/release docs
{
  grep -rl "${EXCLUDES[@]}" "apex" --include="*.sql" -- src/db/migrations/ 2>/dev/null || true
  grep -rl "${EXCLUDES[@]}" "apex" --include="*.md" -- demo/ 2>/dev/null \
    | grep -E "(handoff|release-report)-2026-" || true
} | sort -u > "$OUT_DIR/immutable"

# ACTIVE-SCHEMA: TS source with apex_ table identifiers (no tests, no migrations)
grep -rl "${EXCLUDES[@]}" "apex_" --include="*.ts" --include="*.tsx" -- src/ 2>/dev/null \
  | grep -v __tests__ \
  | grep -v src/db/migrations \
  | sort -u > "$OUT_DIR/active_schema"

# ACTIVE-TYPE: configs + top-level docs
> "$OUT_DIR/active_type"
for f in package.json next.config.ts playwright.config.ts CLAUDE.md README.md SECURITY.md vercel.json; do
  if [[ -f "$f" ]] && grep -q "apex\|Apex\|APEX" "$f" 2>/dev/null; then
    echo "$f" >> "$OUT_DIR/active_type"
  fi
done

# ALL refs
grep -rl "${EXCLUDES[@]}" "apex\|Apex\|APEX" \
  --include="*.ts" --include="*.tsx" --include="*.js" \
  --include="*.json" --include="*.md" --include="*.yml" \
  --include="*.yaml" --include="*.sh" -- . 2>/dev/null \
  | sort -u > "$OUT_DIR/all_refs"

# COSMETIC = ALL minus IMMUTABLE+ACTIVE-SCHEMA+ACTIVE-TYPE
sort -u "$OUT_DIR/immutable" "$OUT_DIR/active_schema" "$OUT_DIR/active_type" > "$OUT_DIR/non_cosmetic"
comm -23 "$OUT_DIR/all_refs" "$OUT_DIR/non_cosmetic" > "$OUT_DIR/cosmetic"

print_bucket() {
  local label="$1" file="$2" cap=20
  local count
  count=$(wc -l < "$file" | tr -d ' ')
  printf "\n=== %s — %d files ===\n" "$label" "$count"
  head -"$cap" "$file"
  if (( count > cap )); then
    printf "  ... and %d more\n" $((count - cap))
  fi
}

print_bucket "IMMUTABLE (do not touch)" "$OUT_DIR/immutable"
print_bucket "ACTIVE-SCHEMA (apex_ table refs in src/ — hit compat views)" "$OUT_DIR/active_schema"
print_bucket "ACTIVE-TYPE (configs + top-level docs)" "$OUT_DIR/active_type"
print_bucket "COSMETIC (comments, tests, scripts)" "$OUT_DIR/cosmetic"

printf "\n=== TOTAL ===\n"
printf "  immutable:     %d\n" "$(wc -l < "$OUT_DIR/immutable" | tr -d ' ')"
printf "  active-schema: %d\n" "$(wc -l < "$OUT_DIR/active_schema" | tr -d ' ')"
printf "  active-type:   %d\n" "$(wc -l < "$OUT_DIR/active_type" | tr -d ' ')"
printf "  cosmetic:      %d\n" "$(wc -l < "$OUT_DIR/cosmetic" | tr -d ' ')"
