#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# add-notification-category.sh
#
# Register a new notification category in one shot:
#   1. Upsert into src/lib/notifications/categories.ts (creates the file if
#      it doesn't exist yet).
#   2. Add a row to the canonical-categories table in README.md.
#   3. Generate a stub integration test at
#      src/lib/__tests__/notify-<category>.test.ts.
#
# Idempotent: re-running is a no-op.
#
# Usage:
#   ./scripts/add-notification-category.sh <category-id> \
#       --source <source> --priority <priority> [--digest <window>]
#
# Example:
#   ./scripts/add-notification-category.sh hr.document_expiring \
#       --source hr --priority normal --digest daily
#
# Exit codes:
#   0 — success / no-op
#   2 — user error (bad args, bad format)
#   1 — system error
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ -n "${REPO_ROOT_OVERRIDE:-}" ]]; then
    REPO_ROOT="${REPO_ROOT_OVERRIDE}"
fi

CATEGORIES_FILE="${REPO_ROOT}/src/lib/notifications/categories.ts"
README_FILE="${REPO_ROOT}/src/lib/notifications/README.md"
TEST_DIR="${REPO_ROOT}/src/lib/__tests__"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

die()  { printf "${RED}error:${NC} %s\n" "$*" >&2; exit "${2:-1}"; }
note() { printf "${BLUE}[add-notification-category]${NC} %s\n" "$*"; }
ok()   { printf "${GREEN}[add-notification-category]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[add-notification-category]${NC} %s\n" "$*"; }

# ── Arg parsing ────────────────────────────────────────────────────────────
if [[ $# -lt 1 ]]; then
    cat >&2 <<EOF
usage: $0 <category-id> --source <source> --priority <priority> [--digest <window>]
  category-id: '<source>.<event>' lowercase, dotted
  source:      one of hr, tasks, finance, security, integrations, team, audit, system
  priority:    low | normal | high | critical
  digest:      off | realtime | daily | weekly  (default: daily)

example:
  $0 hr.document_expiring --source hr --priority normal --digest daily
EOF
    exit 2
fi

CAT_ID="$1"; shift

SOURCE=""
PRIORITY=""
DIGEST="daily"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --source)   SOURCE="$2";   shift 2 ;;
        --priority) PRIORITY="$2"; shift 2 ;;
        --digest)   DIGEST="$2";   shift 2 ;;
        *) die "unknown flag: $1" 2 ;;
    esac
done

# Validate format: source.event
if ! [[ "${CAT_ID}" =~ ^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$ ]]; then
    die "category-id must be 'source.event' (lowercase, dotted): got '${CAT_ID}'" 2
fi

VALID_SOURCES=(hr tasks finance security integrations team audit system)
VALID_PRIORITIES=(low normal high critical)
VALID_DIGESTS=(off realtime daily weekly)

in_list() {
    local needle="$1"; shift
    for v in "$@"; do
        [[ "${needle}" == "${v}" ]] && return 0
    done
    return 1
}

[[ -n "${SOURCE}"   ]] || die "--source required" 2
[[ -n "${PRIORITY}" ]] || die "--priority required" 2
in_list "${SOURCE}"   "${VALID_SOURCES[@]}"    || die "invalid source: ${SOURCE} (valid: ${VALID_SOURCES[*]})" 2
in_list "${PRIORITY}" "${VALID_PRIORITIES[@]}" || die "invalid priority: ${PRIORITY} (valid: ${VALID_PRIORITIES[*]})" 2
in_list "${DIGEST}"   "${VALID_DIGESTS[@]}"    || die "invalid digest: ${DIGEST} (valid: ${VALID_DIGESTS[*]})" 2

# Category prefix should match source (convention from README).
CAT_PREFIX="${CAT_ID%%.*}"
if [[ "${CAT_PREFIX}" != "${SOURCE}" ]]; then
    warn "category-id prefix '${CAT_PREFIX}' does not match --source '${SOURCE}' — this is unusual but allowed"
fi

note "category: ${CAT_ID}"
note "source:   ${SOURCE}"
note "priority: ${PRIORITY}"
note "digest:   ${DIGEST}"

# ── 1. Upsert into categories.ts ───────────────────────────────────────────
mkdir -p "$(dirname "${CATEGORIES_FILE}")"

if [[ ! -f "${CATEGORIES_FILE}" ]]; then
    note "creating ${CATEGORIES_FILE}"
    cat > "${CATEGORIES_FILE}" <<'TS'
/**
 * Notification category registry.
 *
 * Single source of truth for every category that notify() accepts. This file
 * is managed by scripts/add-notification-category.sh — edit by hand only for
 * structural changes, never for new categories.
 *
 * Conventions (enforced by the script):
 *   - id format: `<source>.<event>` (dotted, lowercase)
 *   - source ∈ hr | tasks | finance | security | integrations | team | audit | system
 *   - priority ∈ low | normal | high | critical
 *   - defaultDigest ∈ off | realtime | daily | weekly
 */

import type { NotificationPriority, EmailDigestCadence } from "./in-app";

export interface NotificationCategorySpec {
  id: string;
  source: string;
  defaultPriority: NotificationPriority;
  defaultDigest: EmailDigestCadence;
}

export const NOTIFICATION_CATEGORIES: Record<string, NotificationCategorySpec> = {
  // entries appended by scripts/add-notification-category.sh
};

export function isRegisteredCategory(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(NOTIFICATION_CATEGORIES, id);
}

export function allCategoryIds(): readonly string[] {
  return Object.keys(NOTIFICATION_CATEGORIES).sort();
}
TS
    ok "created categories.ts"
fi

# Idempotent upsert via node (handles new + update).
CAT_ID="${CAT_ID}" SOURCE="${SOURCE}" PRIORITY="${PRIORITY}" DIGEST="${DIGEST}" \
CATEGORIES_FILE="${CATEGORIES_FILE}" \
node - <<'NODE'
const fs = require('node:fs');
const path = process.env.CATEGORIES_FILE;
const id = process.env.CAT_ID;
const source = process.env.SOURCE;
const priority = process.env.PRIORITY;
const digest = process.env.DIGEST;

let src = fs.readFileSync(path, 'utf8');

// Find the NOTIFICATION_CATEGORIES object literal.
const re = /export\s+const\s+NOTIFICATION_CATEGORIES\s*:\s*Record<string,\s*NotificationCategorySpec>\s*=\s*\{([\s\S]*?)\n\};/m;
const m = src.match(re);
if (!m) {
  console.error("could not locate NOTIFICATION_CATEGORIES literal in", path);
  process.exit(1);
}
const body = m[1];

// Idempotent: check for existing entry keyed by id.
// Keys may be quoted (string with '.') or bare (impossible for ids with '.').
const keyRe = new RegExp(`"${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*\\{[^}]*\\}`, 'm');
const already = keyRe.test(body);

const newEntry = `  "${id}": { id: "${id}", source: "${source}", defaultPriority: "${priority}", defaultDigest: "${digest}" },`;

let newBody;
if (already) {
  // Replace the existing block entirely (upsert).
  newBody = body.replace(keyRe, newEntry.trim());
  // The replace may have created awkward spacing; normalize surrounding whitespace.
  newBody = newBody.replace(/\n {2}"/g, '\n  "'); // keep 2-space indent
  console.log(`[upsert] replaced existing entry for ${id}`);
} else {
  // Append before the closing `};`
  const trimmed = body.replace(/\s+$/, '');
  newBody = `${trimmed}\n${newEntry}\n`;
  console.log(`[insert] appended new entry ${id}`);
}

const updated = src.replace(re,
  `export const NOTIFICATION_CATEGORIES: Record<string, NotificationCategorySpec> = {${newBody}};`);
fs.writeFileSync(path, updated, 'utf8');
NODE

ok "categories.ts updated"

# ── 2. Update README.md table ──────────────────────────────────────────────
if [[ -f "${README_FILE}" ]]; then
    if grep -q "\`${CAT_ID}\`" "${README_FILE}"; then
        warn "README.md already documents ${CAT_ID} — skipping"
    else
        note "appending row to README.md categories table"
        # Insert a row at the end of the canonical table. We identify the
        # table by the header line and append just before the next `##`
        # heading (or end of file).
        CAT_ID="${CAT_ID}" SOURCE="${SOURCE}" README_FILE="${README_FILE}" \
        node - <<'NODE'
const fs = require('node:fs');
const path = process.env.README_FILE;
const id = process.env.CAT_ID;
const source = process.env.SOURCE;
let src = fs.readFileSync(path, 'utf8');

// Find the table header then the end of the table block (first blank line
// after the header separator).
const headerIdx = src.indexOf('| Owner module');
if (headerIdx === -1) {
  console.log('[note] README has no canonical table header; appending a brief line at end');
  const addition = `\n- \`${id}\` (source \`${source}\`) — registered via scripts/add-notification-category.sh\n`;
  fs.writeFileSync(path, src + addition, 'utf8');
  process.exit(0);
}
// Walk forward to find the last table row (line starting with `|`).
const lines = src.split('\n');
let startLine = src.slice(0, headerIdx).split('\n').length - 1;
// Header is at startLine; advance to last consecutive pipe-row.
let lastRow = startLine;
for (let i = startLine + 1; i < lines.length; i++) {
  if (lines[i].trimStart().startsWith('|')) lastRow = i;
  else if (lines[i].trim() === '') break;
}
const ownerModule = source.charAt(0).toUpperCase() + source.slice(1);
const row = `| ${ownerModule.padEnd(14)} | \`${source.padEnd(12)}\` | \`${id.padEnd(31)}\` | Added via scripts/add-notification-category.sh                  |`;
lines.splice(lastRow + 1, 0, row);
fs.writeFileSync(path, lines.join('\n'), 'utf8');
console.log(`[ok] README row inserted after line ${lastRow + 1}`);
NODE
        ok "README.md updated"
    fi
else
    warn "README.md not found — skipping doc update"
fi

# ── 3. Generate stub integration test ──────────────────────────────────────
mkdir -p "${TEST_DIR}"

# Test file name uses dots→dashes for safety.
TEST_SLUG="$(echo "${CAT_ID}" | tr '.' '-')"
TEST_FILE="${TEST_DIR}/notify-${TEST_SLUG}.test.ts"

if [[ -f "${TEST_FILE}" ]]; then
    warn "test already exists — skipping: ${TEST_FILE}"
else
    note "generating stub test ${TEST_FILE}"
    cat > "${TEST_FILE}" <<TS
/**
 * Stub integration test for the '${CAT_ID}' notification category.
 *
 * Generated by scripts/add-notification-category.sh. This asserts the
 * category is registered and shows the canonical emission shape. Replace
 * the pending test below with a real end-to-end assertion once the
 * emitting code path exists.
 */
import {
  NOTIFICATION_CATEGORIES,
  isRegisteredCategory,
} from "@/lib/notifications/categories";

describe("notification category: ${CAT_ID}", () => {
  it("is registered in NOTIFICATION_CATEGORIES", () => {
    expect(isRegisteredCategory("${CAT_ID}")).toBe(true);
  });

  it("has correct source + defaults", () => {
    const spec = NOTIFICATION_CATEGORIES["${CAT_ID}"];
    expect(spec).toBeDefined();
    expect(spec.source).toBe("${SOURCE}");
    expect(spec.defaultPriority).toBe("${PRIORITY}");
    expect(spec.defaultDigest).toBe("${DIGEST}");
  });

  // Pending: wire a real notify() call once the emitting code path exists.
  // Example:
  //
  //   it("emits via notify()", async () => {
  //     await notify({
  //       userId: "user-under-test",
  //       category: "${CAT_ID}",
  //       title: "test title",
  //       source: "${SOURCE}",
  //       priority: "${PRIORITY}",
  //     });
  //   });
  it.todo("emits via notify() against a seeded user");
});
TS
    ok "stub test generated"
fi

# ── Done ───────────────────────────────────────────────────────────────────
cat <<EOF

${GREEN}done.${NC}

To emit this notification:

  await notify({
    userId,
    category: '${CAT_ID}',
    title: '…',
    source: '${SOURCE}',
    priority: '${PRIORITY}',
  });

Next:
  1. Fill in the TODO in ${TEST_FILE} with a real notify() assertion.
  2. Commit:
       git add src/lib/notifications/categories.ts \\
               src/lib/notifications/README.md \\
               ${TEST_FILE}
       git commit -m "feat(notifications): register ${CAT_ID} category"

EOF
