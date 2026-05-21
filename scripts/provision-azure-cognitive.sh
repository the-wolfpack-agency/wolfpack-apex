#!/usr/bin/env bash
# Provision an Azure AI Services (multi-service) resource for
# Wolfpack Instinct + push the keys to Vercel.
#
# Idempotent. Cost: S0 SKU, fully covered by the 12-month free
# Azure credit at our forecast volume. F0 doesn't cover Form
# Recognizer's prebuilt-invoice model so we go S0.

set -eo pipefail

RESOURCE_NAME="${1:-wolfpack-cog-svc}"
LOCATION="${2:-eastus}"
RG="${AZURE_RESOURCE_GROUP:-wolfpack-rg}"
SKU="S0"
VERCEL_ORG="team_01C9nOyTsDeKN4nBST28JYS5"

echo "Provisioning Azure AI Services for Wolfpack Instinct"
echo "  resource name: $RESOURCE_NAME"
echo "  region:        $LOCATION"
echo "  resource grp:  $RG"
echo "  SKU:           $SKU"

SUB=$(az account show --query id -o tsv 2>/dev/null || true)
if [ -z "$SUB" ]; then
  echo "ERROR: not logged in to Azure. Run 'az login' first." >&2
  exit 1
fi
echo "OK - Azure subscription: $SUB"

echo "-> Ensuring resource group $RG in $LOCATION..."
az group create --name "$RG" --location "$LOCATION" --output none
echo "OK - Resource group ready"

echo "-> Provisioning Cognitive Services resource..."
EXISTING=$(az cognitiveservices account show \
  --name "$RESOURCE_NAME" \
  --resource-group "$RG" \
  --query name -o tsv 2>/dev/null || true)
if [ -n "$EXISTING" ]; then
  echo "   (already exists - reusing)"
else
  az cognitiveservices account create \
    --name "$RESOURCE_NAME" \
    --resource-group "$RG" \
    --kind "CognitiveServices" \
    --sku "$SKU" \
    --location "$LOCATION" \
    --yes \
    --output none
  echo "OK - Created"
fi

ENDPOINT=$(az cognitiveservices account show \
  --name "$RESOURCE_NAME" --resource-group "$RG" \
  --query properties.endpoint -o tsv)
KEY=$(az cognitiveservices account keys list \
  --name "$RESOURCE_NAME" --resource-group "$RG" \
  --query key1 -o tsv)

echo "OK - Endpoint: $ENDPOINT"
echo "OK - Key1 length: ${#KEY}"

echo "-> Writing to Vercel production env..."
cd "$(dirname "$0")/.."

push_env() {
  local name="$1"
  local value="$2"
  npx vercel env rm "$name" production --scope="$VERCEL_ORG" --yes >/dev/null 2>&1 || true
  npx vercel env add "$name" production \
    --scope="$VERCEL_ORG" \
    --value "$value" \
    --yes
}

push_env "AZURE_COGNITIVE_ENDPOINT" "$ENDPOINT"
push_env "AZURE_COGNITIVE_KEY" "$KEY"
echo "OK - Vercel env vars set"

echo "-> Triggering Vercel redeploy via empty commit..."
git commit --allow-empty -m "chore(deploy): pick up Azure Cognitive Services env vars" >/dev/null
git push >/dev/null
echo "OK - Pushed. Vercel build will pick up the new keys in ~2 min."
echo ""
echo "Verify with: GET /api/admin/azure-status"
echo "Expected: configured.computer_vision=true AND form_recognizer=true"
