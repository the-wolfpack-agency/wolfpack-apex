#!/usr/bin/env bash
set -euo pipefail

# sync-template-to-client-repos.sh
#
# Copy every workflow under .github/workflows/ from the canonical
# wolfpack-site-template into every existing client repo under the
# the-wolfpack-agency org whose name starts with `wolfpack-` (except
# the template itself and a small denylist).
#
# Idempotent: compares the new blob against the remote file's SHA; if
# they match, nothing is written. If the file doesn't exist on the
# client yet, it's created.
#
# Use when a template fix (like the 2026-04-18 --scope fix) needs to
# propagate to repos that already exist. New repos get the template at
# creation time, so they're fine.
#
# Usage: scripts/sync-template-to-client-repos.sh [dry-run]
#   dry-run   — print what would change, don't write

DRY="${1:-}"

TEMPLATE_OWNER="the-wolfpack-agency"
TEMPLATE_REPO="wolfpack-site-template"
ORG="the-wolfpack-agency"

# Repos to skip even though their name matches `wolfpack-*`.
# - wolfpack-apex (Instinct itself — different workflows)
# - wolfpack-auto (different product, not Sites-based)
# - wolfpack-site-template (source of truth, not a target)
# - wolfpack-lms (separate product)
DENY=("wolfpack-apex" "wolfpack-auto" "wolfpack-site-template" "wolfpack-lms")

echo "==> Listing template workflow files"
files=$(gh api "repos/$TEMPLATE_OWNER/$TEMPLATE_REPO/contents/.github/workflows" --jq '.[] | select(.type=="file") | .name')
echo "$files" | sed 's/^/    /'

echo "==> Listing client repos under $ORG starting with wolfpack-"
repos=$(gh api "orgs/$ORG/repos?per_page=100" --jq '.[] | select(.name | startswith("wolfpack-")) | .name')

for repo in $repos; do
  skip=false
  for d in "${DENY[@]}"; do
    if [[ "$repo" == "$d" ]]; then skip=true; break; fi
  done
  if [[ "$skip" == true ]]; then
    echo "    [skip] $repo (denylisted)"
    continue
  fi

  for f in $files; do
    echo "==> $repo :: $f"

    # Fetch canonical template blob + hash.
    new_content=$(gh api "repos/$TEMPLATE_OWNER/$TEMPLATE_REPO/contents/.github/workflows/$f" --jq '.content')
    new_sha=$(gh api "repos/$TEMPLATE_OWNER/$TEMPLATE_REPO/contents/.github/workflows/$f" --jq '.sha')

    # Fetch client's current blob (if any).
    if cur_json=$(gh api "repos/$ORG/$repo/contents/.github/workflows/$f" 2>/dev/null); then
      cur_sha=$(echo "$cur_json" | jq -r '.sha')
      if [[ "$cur_sha" == "$new_sha" ]]; then
        echo "    up-to-date (sha $cur_sha)"
        continue
      fi
      msg="chore(canary): sync $f from template"
      if [[ "$DRY" == "dry-run" ]]; then
        echo "    [dry] would update (client sha $cur_sha → template sha $new_sha)"
      else
        gh api -X PUT "repos/$ORG/$repo/contents/.github/workflows/$f" \
          -f message="$msg" -f content="$new_content" -f sha="$cur_sha" \
          --jq '.commit.sha' | sed 's/^/    committed /'
      fi
    else
      msg="chore(canary): add $f from template"
      if [[ "$DRY" == "dry-run" ]]; then
        echo "    [dry] would create (new file)"
      else
        gh api -X PUT "repos/$ORG/$repo/contents/.github/workflows/$f" \
          -f message="$msg" -f content="$new_content" \
          --jq '.commit.sha' | sed 's/^/    created /'
      fi
    fi
  done
done

echo "==> Done. Any repos whose workflows changed will have auto-dispatched a new run."
