#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# recall.sh — search the local Wolfpack Instinct knowledge base
#
# Strategy (first reachable wins):
#   1. If QDRANT_URL is reachable AND the `apex_knowledge` collection exists:
#      scroll-search the payload for `question` / `answer` substrings.
#      (The current triple-write uses a 4-dim zero vector, so true
#      semantic search is a no-op; payload substring matching is the
#      best we can do here.)
#   2. If INSTINCT_URL is set, hit GET /api/knowledge?q=<query>&limit=<n>
#      with INSTINCT_AUTH_TOKEN as bearer if provided.
#   3. Otherwise graceful error.
#
# Usage:
#   ./scripts/recall.sh "<query>" [--top <n>]
#
# Env:
#   QDRANT_URL           default: http://localhost:6333
#   INSTINCT_URL         e.g. http://localhost:3000
#   INSTINCT_AUTH_TOKEN  bearer token for /api/knowledge (optional)
#
# Exit:
#   0 — results (possibly empty) printed
#   2 — user error (missing query, bad flag)
#   1 — system error (no backend reachable)
# ---------------------------------------------------------------------------
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
DIM='\033[2m'
NC='\033[0m'

die()  { printf "${RED}error:${NC} %s\n" "$*" >&2; exit "${2:-1}"; }
note() { printf "${BLUE}[recall]${NC} %s\n" "$*" >&2; }

QDRANT_URL="${QDRANT_URL:-http://localhost:6333}"
COLLECTION="${RECALL_COLLECTION:-apex_knowledge}"

# ── Arg parsing ────────────────────────────────────────────────────────────
if [[ $# -lt 1 ]]; then
    cat >&2 <<EOF
usage: $0 "<query>" [--top <n>]
example:
  $0 "how do we gate an API route"
  $0 "payroll override" --top 5
EOF
    exit 2
fi

QUERY="$1"; shift || true
TOP=5

while [[ $# -gt 0 ]]; do
    case "$1" in
        --top) TOP="$2"; shift 2 ;;
        *) die "unknown flag: $1" 2 ;;
    esac
done

if ! [[ "${TOP}" =~ ^[0-9]+$ ]]; then
    die "--top must be a positive integer, got '${TOP}'" 2
fi

# ── Helpers ───────────────────────────────────────────────────────────────
qdrant_reachable() {
    curl -fsS -m 2 "${QDRANT_URL}/collections/${COLLECTION}" > /dev/null 2>&1
}

instinct_reachable() {
    [[ -n "${INSTINCT_URL:-}" ]] || return 1
    curl -fsS -m 2 "${INSTINCT_URL}/api/health" > /dev/null 2>&1 ||
    curl -fsS -m 2 "${INSTINCT_URL}" > /dev/null 2>&1
}

# ── Path 1: Qdrant scroll search ──────────────────────────────────────────
try_qdrant() {
    qdrant_reachable || return 1
    note "using Qdrant at ${QDRANT_URL} (collection=${COLLECTION})"

    # Scroll returns all points in pages. We pull one page with a reasonable
    # upper bound, filter client-side by substring, rank by match count.
    # This is deliberately not a vector search — with 4-dim zero vectors
    # there is no meaningful semantic scoring to do.
    local body
    body=$(curl -fsS -m 10 -X POST \
        -H "Content-Type: application/json" \
        -d '{"limit": 256, "with_payload": true, "with_vector": false}' \
        "${QDRANT_URL}/collections/${COLLECTION}/points/scroll" 2>/dev/null) || return 1

    # Pass the JSON payload via env var (avoids stdin-vs-script ambiguity
    # with `node -`). We write the script to a temp file and invoke it.
    local script_file
    script_file=$(mktemp)
    trap 'rm -f "${script_file}"' RETURN
    cat > "${script_file}" <<'NODE'
const parsed = JSON.parse(process.env.QDRANT_BODY || '{}');
const query = (process.env.QUERY || '').toLowerCase();
const top = parseInt(process.env.TOP || '5', 10);
const points = (parsed.result && parsed.result.points) || [];

const tokens = query.split(/\s+/).filter(Boolean);
const scored = [];
for (const p of points) {
  const payload = p.payload || {};
  const hay = [
    payload.question || '',
    payload.answer || '',
    (payload.tags || []).join(' '),
    payload.source || '',
  ].join(' ').toLowerCase();
  let score = 0;
  for (const t of tokens) if (hay.includes(t)) score += 1;
  if (score > 0) scored.push({ score, payload, id: p.id });
}
scored.sort((a, b) => b.score - a.score);
const hits = scored.slice(0, top);
if (hits.length === 0) {
  console.log('no matches.');
  process.exit(0);
}
for (let i = 0; i < hits.length; i++) {
  const h = hits[i];
  const pl = h.payload;
  const snippet = (pl.answer || '').replace(/\s+/g, ' ').slice(0, 160);
  console.log(`#${i + 1}  [score=${h.score}]  ${pl.question || '(no question)'}`);
  console.log(`     source: ${pl.source || '-'}   repo: ${pl.repo || '-'}   indexed: ${pl.indexed_at || '-'}`);
  if (snippet) console.log(`     ${snippet}…`);
  console.log('');
}
NODE
    QDRANT_BODY="${body}" QUERY="${QUERY}" TOP="${TOP}" node "${script_file}"
}

# ── Path 2: Instinct API /api/knowledge?q=… ────────────────────────────────
try_instinct() {
    instinct_reachable || return 1
    note "using Instinct API at ${INSTINCT_URL}"
    local auth_header=()
    if [[ -n "${INSTINCT_AUTH_TOKEN:-}" ]]; then
        auth_header=(-H "Authorization: Bearer ${INSTINCT_AUTH_TOKEN}")
    fi
    # URL-encode the query via node (no jq dependency).
    local encoded
    encoded=$(QUERY="${QUERY}" node -e 'process.stdout.write(encodeURIComponent(process.env.QUERY||""))')
    local body
    body=$(curl -fsS -m 10 \
        "${auth_header[@]}" \
        "${INSTINCT_URL}/api/knowledge?q=${encoded}&limit=${TOP}") || return 1

    local script_file
    script_file=$(mktemp)
    trap 'rm -f "${script_file}"' RETURN
    cat > "${script_file}" <<'NODE'
const parsed = JSON.parse(process.env.INSTINCT_BODY || '{}');
const entries = parsed.entries || parsed.results || [];
const top = parseInt(process.env.TOP || '5', 10);
if (entries.length === 0) { console.log('no matches.'); process.exit(0); }
for (let i = 0; i < Math.min(entries.length, top); i++) {
  const e = entries[i];
  const snippet = (e.answer || e.snippet || '').replace(/\s+/g, ' ').slice(0, 160);
  console.log(`#${i + 1}  ${e.question || e.title || '(untitled)'}`);
  console.log(`     source: ${e.source || '-'}   score: ${e.score ?? '-'}`);
  if (snippet) console.log(`     ${snippet}…`);
  console.log('');
}
NODE
    INSTINCT_BODY="${body}" TOP="${TOP}" node "${script_file}"
}

# ── Dispatch ───────────────────────────────────────────────────────────────
if try_qdrant; then
    exit 0
fi
if try_instinct; then
    exit 0
fi

printf "${YELLOW}[recall]${NC} no backend reachable.\n" >&2
printf "  tried Qdrant at: %s\n" "${QDRANT_URL}" >&2
printf "  tried Instinct at: %s\n" "${INSTINCT_URL:-(unset)}" >&2
printf "  tips:\n" >&2
printf "    docker ps | grep qdrant\n" >&2
printf "    export INSTINCT_URL=http://localhost:3000\n" >&2
exit 1
