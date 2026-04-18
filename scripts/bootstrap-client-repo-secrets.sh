#!/usr/bin/env bash
set -euo pipefail

# bootstrap-client-repo-secrets.sh
#
# Push the 5 Actions secrets a Wolfpack client repo needs so its
# canary-deploy.yml workflow can run. Use this to unblock a repo when
# Instinct's server-side auto-provisioning hasn't populated them (e.g.
# the Instinct GitHub PAT lacks Secrets:Read-and-write scope).
#
# Usage:
#   export VERCEL_TOKEN=vcp_...
#   export WOLFPACK_SITES_WEBHOOK_SECRET=whatever_you_set_on_instinct
#   scripts/bootstrap-client-repo-secrets.sh the-wolfpack-agency/wolfpack-test2
#
# Requires: gh CLI logged in with repo scope (`gh auth status` to check).

REPO="${1:-}"
if [[ -z "$REPO" ]]; then
  echo "usage: $0 <owner/repo>" >&2
  exit 2
fi

: "${VERCEL_TOKEN:?export VERCEL_TOKEN=vcp_...}"
: "${WOLFPACK_SITES_WEBHOOK_SECRET:?export WOLFPACK_SITES_WEBHOOK_SECRET=...}"

VERCEL_ORG_ID="${VERCEL_ORG_ID:-team_01C9nOyTsDeKN4nBST28JYS5}"
INSTINCT_WEBHOOK_URL="${INSTINCT_WEBHOOK_URL:-https://wolfpack-instinct.vercel.app/api/sites/webhook}"

# Derive the Vercel project name from the repo name.
# wolfpack-test2 -> project name wolfpack-test2 (our convention).
PROJECT_NAME="${REPO##*/}"

echo "==> Looking up Vercel project id for $PROJECT_NAME"
PROJECT_ID=$(curl -fsS \
  -H "Authorization: Bearer $VERCEL_TOKEN" \
  "https://api.vercel.com/v10/projects/$PROJECT_NAME?teamId=$VERCEL_ORG_ID" \
  | jq -r '.id // empty')

if [[ -z "$PROJECT_ID" ]]; then
  echo "==> No existing Vercel project '$PROJECT_NAME' — creating it"
  PROJECT_ID=$(curl -fsS \
    -X POST \
    -H "Authorization: Bearer $VERCEL_TOKEN" \
    -H "Content-Type: application/json" \
    "https://api.vercel.com/v10/projects?teamId=$VERCEL_ORG_ID" \
    --data "{\"name\":\"$PROJECT_NAME\",\"framework\":\"nextjs\"}" \
    | jq -r '.id')
fi
echo "    VERCEL_PROJECT_ID = $PROJECT_ID"

echo "==> Setting 5 Actions secrets on $REPO"
echo -n "$VERCEL_TOKEN"                     | gh secret set VERCEL_TOKEN                     --repo "$REPO"
echo -n "$VERCEL_ORG_ID"                    | gh secret set VERCEL_ORG_ID                    --repo "$REPO"
echo -n "$PROJECT_ID"                       | gh secret set VERCEL_PROJECT_ID                --repo "$REPO"
echo -n "$INSTINCT_WEBHOOK_URL"             | gh secret set INSTINCT_WEBHOOK_URL             --repo "$REPO"
echo -n "$WOLFPACK_SITES_WEBHOOK_SECRET"    | gh secret set WOLFPACK_SITES_WEBHOOK_SECRET    --repo "$REPO"

echo "==> Done. Verify with: gh api repos/$REPO/actions/secrets"
