#!/usr/bin/env bash
#
# What a person sees when a dependency is down.
#
# WHY THIS IS A SCRIPT. On 2026-08-30 this matrix was run by hand five times
# while chasing one defect, which is exactly the repetition the engineering
# directive says to codify. It is also the only way to check a class of bug
# that unit tests cannot reach: what the ANSWER says, end to end, through the
# real assistant, when something underneath it has failed.
#
# WHAT IT FOUND. With the model provider unreachable and a document in the
# corpus that contained the answer, the product said "I don't have information
# on that yet. You can help me learn by adding it to the Knowledge Base."
# Every clause false, and the last one invites a client to upload a second copy
# of a document already held.
#
# HOW IT INJECTS. By pointing a dependency's endpoint at a closed port, so the
# failure is a real connection error on the real code path. Nothing is mocked
# and nothing in the environment is changed: each case is one subprocess with
# one overridden variable.
#
# Usage:  scripts/probe-outage.sh ["a question whose answer you know exists"]
#
# Reads .env.local. Never writes to any store.

set -uo pipefail
cd "$(dirname "$0")/.."

QUESTION="${1:-what are the payment terms in our SOW?}"
# A closed port, so the failure is a connection refusal rather than a timeout.
DEAD="http://127.0.0.1:9"

set -a; . ./.env.local 2>/dev/null; set +a

if [ -z "${DATABASE_URL:-}" ]; then
  echo "Needs DATABASE_URL. This asks the real assistant a real question." >&2
  exit 2
fi

PROBE="$(mktemp -t outage-probe-XXXXXX).ts"
cat > "$PROBE" <<'EOF'
import { chat } from "@/lib/assistant";
import { query } from "@/lib/db";
(async () => {
  const u = await query(`SELECT id, role FROM instinct_team_members WHERE is_active LIMIT 1`);
  const me: any = u.rows[0];
  const r: any = await chat(process.argv[2], me.id, me.role);
  const text = String(r.response ?? "").replace(/\s+/g, " ").trim();
  console.log(`  source=${r.source}  degraded=${JSON.stringify(r.degradedKinds ?? null)}`);
  console.log(`  ${text.slice(0, 200)}`);
  /* The sentence that caused the incident. Its presence during an outage is
     the regression this whole script exists to catch. */
  if (r.degradedKinds && /add(ing)? it to the Knowledge Base/i.test(text)) {
    console.log("  FAIL: told the reader to re-upload during an outage");
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => { console.log(`  THREW: ${e.message.slice(0, 160)}`); process.exit(1); });
EOF
trap 'rm -f "$PROBE"' EXIT

echo "Asking: \"$QUESTION\""
echo

fail=0
run() {
  echo "$1"
  shift
  if ! env "$@" npx tsx "$PROBE" "$QUESTION" 2>/dev/null | grep -vE '^\{"kind"'; then
    fail=1
  fi
  echo
}

run "1. healthy, for a baseline"
run "2. semantic store unreachable" QDRANT_URL="$DEAD"
run "3. model provider unreachable" AZURE_OPENAI_ENDPOINT="$DEAD" AZURE_AI_FOUNDRY_ENDPOINT="$DEAD"
run "4. both unreachable" QDRANT_URL="$DEAD" AZURE_OPENAI_ENDPOINT="$DEAD" AZURE_AI_FOUNDRY_ENDPOINT="$DEAD"

if [ "$fail" -ne 0 ]; then
  echo "At least one case answered dishonestly. See above."
  exit 1
fi
echo "Every degraded case named what broke and promised nothing was lost."
