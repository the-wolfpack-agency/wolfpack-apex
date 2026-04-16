#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# add-capability.sh
#
# Register a new capability in the Instinct authorization system without
# hand-editing capabilities.ts + role-capabilities.ts each time. Idempotent
# by design — safe to re-run after a partial failure.
#
# Usage:
#   ./scripts/add-capability.sh <capability-id> <role1,role2,...> "<description>"
#
# Example:
#   ./scripts/add-capability.sh hr.payroll.override "ceo,cto" "Override payroll calculations manually"
#
# Exit codes:
#   0 — success (or already registered; no-op)
#   2 — user error (bad args, unknown role, bad capability format)
#   1 — system error (edit failed, jest failed)
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CAPS_FILE="${REPO_ROOT}/src/lib/auth/capabilities.ts"
ROLES_FILE="${REPO_ROOT}/src/lib/auth/role-capabilities.ts"
COVERAGE_TEST="src/__tests__/capability-coverage.test.ts"

# Allow tests to point at an alternate repo root via REPO_ROOT_OVERRIDE.
if [[ -n "${REPO_ROOT_OVERRIDE:-}" ]]; then
    REPO_ROOT="${REPO_ROOT_OVERRIDE}"
    CAPS_FILE="${REPO_ROOT}/src/lib/auth/capabilities.ts"
    ROLES_FILE="${REPO_ROOT}/src/lib/auth/role-capabilities.ts"
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

die()  { printf "${RED}error:${NC} %s\n" "$*" >&2; exit "${2:-1}"; }
note() { printf "${BLUE}[add-capability]${NC} %s\n" "$*"; }
ok()   { printf "${GREEN}[add-capability]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[add-capability]${NC} %s\n" "$*"; }

# ── Arg validation ─────────────────────────────────────────────────────────
if [[ $# -lt 3 ]]; then
    cat >&2 <<EOF
usage: $0 <capability-id> <role1,role2,...> "<description>"
  capability-id: module.action or module.subresource.action (lowercase, dotted)
  roles:         comma-separated: ceo,cto,dev,sales,ops,hr,designer
  description:   short sentence describing the permission

example:
  $0 hr.payroll.override "ceo,cto" "Override payroll calculations manually"
EOF
    exit 2
fi

CAP_ID="$1"
ROLES_CSV="$2"
DESCRIPTION="$3"

# Capability ID format: module.action or module.sub.action (2 or 3 segments)
if ! [[ "${CAP_ID}" =~ ^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$ ]]; then
    die "capability ID must be 'module.action' or 'module.sub.action' (lowercase, dotted): got '${CAP_ID}'" 2
fi

# Roles must be from the known set.
KNOWN_ROLES=(ceo cto dev sales ops hr designer)
IFS=',' read -ra REQUESTED_ROLES <<< "${ROLES_CSV}"
if [[ ${#REQUESTED_ROLES[@]} -eq 0 ]]; then
    die "at least one role required" 2
fi
for r in "${REQUESTED_ROLES[@]}"; do
    r_trimmed="$(echo "${r}" | tr -d '[:space:]')"
    found=0
    for known in "${KNOWN_ROLES[@]}"; do
        if [[ "${known}" == "${r_trimmed}" ]]; then found=1; break; fi
    done
    if [[ ${found} -eq 0 ]]; then
        die "unknown role: '${r_trimmed}' (must be one of: ${KNOWN_ROLES[*]})" 2
    fi
done

# Files must exist.
[[ -f "${CAPS_FILE}"  ]] || die "capabilities file not found: ${CAPS_FILE}"
[[ -f "${ROLES_FILE}" ]] || die "role-capabilities file not found: ${ROLES_FILE}"

note "capability: ${CAP_ID}"
note "roles:      ${ROLES_CSV}"

# ── Check existing registration ────────────────────────────────────────────
already_registered=0
if grep -q "\"${CAP_ID}\"" "${CAPS_FILE}"; then
    already_registered=1
fi

# ── Insert into capabilities.ts (if missing) ───────────────────────────────
# Insert immediately before the closing `} as const;` of the CAPABILITIES block.
# We use node for a robust edit — no fragile sed substitutions across lines.
if [[ ${already_registered} -eq 0 ]]; then
    note "adding ${CAP_ID} to capabilities.ts"
    CAP_ID="${CAP_ID}" DESCRIPTION="${DESCRIPTION}" CAPS_FILE="${CAPS_FILE}" \
    node - <<'NODE'
const fs = require('node:fs');
const path = process.env.CAPS_FILE;
const capId = process.env.CAP_ID;
const desc  = (process.env.DESCRIPTION || '').replace(/"/g, '\\"');
let src = fs.readFileSync(path, 'utf8');

// Locate the closing "} as const;" that terminates the CAPABILITIES object
// literal. Insert before the trailing brace.
const anchor = /\n\}\s*as\s+const\s*;/m;
const match = src.match(anchor);
if (!match) {
  console.error("could not find closing '} as const;' in", path);
  process.exit(1);
}
const insertion = `\n  // added by scripts/add-capability.sh\n  "${capId}": "${desc}",`;
src = src.slice(0, match.index) + insertion + src.slice(match.index);
fs.writeFileSync(path, src, 'utf8');
NODE
    ok "capabilities.ts updated"
else
    warn "already registered in capabilities.ts — skipping"
fi

# ── Insert into role-capabilities.ts (idempotent per role) ─────────────────
# Each role has a `const <ROLE>: readonly Capability[] = [...]` block. We
# append our capability if not already present.
# CTO gets all caps implicitly (filter ALL_CAPS) so skip it.
# CEO gets ALL_CAPS.filter(...) — we only need to add to the filter exclusion
# list IF the caller did NOT include "ceo". If ceo IS included, nothing to do
# (CEO already has it via ALL_CAPS). If ceo is NOT included, we would need to
# exclude it — but that's a judgment call the human should make. We print a
# warning rather than mutating the exclusion filter automatically.

ROLE_VAR_MAP() {
    case "$1" in
        cto)      echo "CTO" ;;
        ceo)      echo "CEO" ;;
        hr)       echo "HR" ;;
        sales)    echo "SALES" ;;
        ops)      echo "OPS" ;;
        dev)      echo "DEV" ;;
        designer) echo "DESIGNER" ;;
    esac
}

requested_has_role() {
    local target="$1"
    for r in "${REQUESTED_ROLES[@]}"; do
        r_trimmed="$(echo "${r}" | tr -d '[:space:]')"
        if [[ "${r_trimmed}" == "${target}" ]]; then return 0; fi
    done
    return 1
}

# Warn if requested roles don't include ceo/cto — they get everything by
# default, so the caller may want to reconsider their role list.
if ! requested_has_role cto; then
    warn "cto NOT in requested roles — but CTO has ALL capabilities by default (ALL_CAPS). No edit needed for cto."
fi
if ! requested_has_role ceo; then
    warn "ceo NOT in requested roles — but CEO inherits ALL_CAPS.filter(...). If you want to EXCLUDE ceo from '${CAP_ID}', hand-edit the CEO filter in role-capabilities.ts."
fi

for role in "${REQUESTED_ROLES[@]}"; do
    role_trimmed="$(echo "${role}" | tr -d '[:space:]')"
    # cto/ceo inherit from ALL_CAPS — nothing to add explicitly.
    if [[ "${role_trimmed}" == "cto" || "${role_trimmed}" == "ceo" ]]; then
        note "role '${role_trimmed}' inherits all capabilities — no edit needed"
        continue
    fi
    role_var="$(ROLE_VAR_MAP "${role_trimmed}")"
    if [[ -z "${role_var}" ]]; then
        warn "no variable mapping for role '${role_trimmed}' — skipping"
        continue
    fi

    note "adding ${CAP_ID} to ${role_var} block"
    CAP_ID="${CAP_ID}" ROLE_VAR="${role_var}" ROLES_FILE="${ROLES_FILE}" \
    node - <<'NODE'
const fs = require('node:fs');
const path = process.env.ROLES_FILE;
const capId = process.env.CAP_ID;
const roleVar = process.env.ROLE_VAR;
let src = fs.readFileSync(path, 'utf8');

// Match: const ROLE: readonly Capability[] = [ ... ];
// Handle multi-line bodies. Use [\s\S] to match newlines.
const pattern = new RegExp(
  String.raw`(const\s+${roleVar}\s*:\s*readonly\s+Capability\[\]\s*=\s*\[)([\s\S]*?)(\n\];)`,
  'm',
);
const m = src.match(pattern);
if (!m) {
  // CTO/CEO use ALL_CAPS.filter(...) — not an explicit array literal. Skip.
  console.log(`[note] ${roleVar} is not an array literal; skipping (handled via ALL_CAPS).`);
  process.exit(0);
}
const body = m[2];
// Idempotent: skip if already listed.
const alreadyListed = new RegExp(`"${capId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(body);
if (alreadyListed) {
  console.log(`[note] ${capId} already in ${roleVar} — skipping.`);
  process.exit(0);
}
// Append before the closing `];` — find the last non-empty line and insert
// after it. Simpler: just inject a new line before the closing bracket.
const injected = `${m[1]}${body}\n  "${capId}",${m[3]}`;
src = src.replace(pattern, injected);
fs.writeFileSync(path, src, 'utf8');
console.log(`[ok] injected into ${roleVar}`);
NODE
done

# ── Summary diff ──────────────────────────────────────────────────────────
note "diff summary"
if command -v git >/dev/null 2>&1 && git -C "${REPO_ROOT}" rev-parse --show-toplevel >/dev/null 2>&1; then
    git -C "${REPO_ROOT}" --no-pager diff --stat -- \
        "src/lib/auth/capabilities.ts" \
        "src/lib/auth/role-capabilities.ts" || true
fi

# ── Run the coverage test to confirm we didn't break anything ──────────────
if [[ -z "${SKIP_JEST:-}" ]]; then
    note "running ${COVERAGE_TEST}"
    if [[ -f "${REPO_ROOT}/node_modules/.bin/jest" ]]; then
        (cd "${REPO_ROOT}" && npx --no-install jest "${COVERAGE_TEST}" --no-coverage) \
            || die "capability-coverage test FAILED — revert or investigate"
        ok "capability-coverage test passed"
    else
        warn "node_modules not installed — skipping jest"
    fi
else
    warn "SKIP_JEST set — skipping jest run"
fi

# ── Next steps ────────────────────────────────────────────────────────────
cat <<EOF

${GREEN}done.${NC}

Next steps:
  1. To gate a route handler, add:

       const gate = await requireCapability(req, '${CAP_ID}');
       if (!gate.ok) return gate.response;

  2. Commit:

       git add src/lib/auth/capabilities.ts src/lib/auth/role-capabilities.ts
       git commit -m "feat(auth): add ${CAP_ID} capability"

EOF
