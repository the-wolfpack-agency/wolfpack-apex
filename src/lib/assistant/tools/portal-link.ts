/**
 * Build an AssistantSourceRef pointing at /portal/salesforce for a
 * specific record. Used by the CRM read/search tools so every chat
 * answer that names a Salesforce record carries a clickable
 * "Open in Wolfpack portal" link alongside the existing "Open in
 * Salesforce" external link.
 *
 * Why a separate helper:
 *   - Keep the URL shape in ONE place. If /portal/salesforce ever moves,
 *     we update here only.
 *   - Keep the `type` + `id` → URL mapping symmetric with the portal's
 *     own routing rules (contacts / opportunities / accounts).
 *
 * The connector name guard means hubspot / quickbooks / etc records
 * never get a portal link until we ship their portals.
 */

import type { AssistantSourceRef } from "@/lib/assistant";

const OBJECT_TO_PORTAL_TYPE: Record<string, "contacts" | "opportunities" | "accounts"> = {
  contact: "contacts",
  deal: "opportunities",
  opportunity: "opportunities",
  company: "accounts",
  account: "accounts",
};

export function maybePortalSource(args: {
  connectorName: string;
  objectType: string;
  id: string;
}): AssistantSourceRef | null {
  if (args.connectorName !== "salesforce") return null;
  const portalType = OBJECT_TO_PORTAL_TYPE[args.objectType.toLowerCase()];
  if (!portalType) return null;
  if (!args.id) return null;
  return {
    id: `portal-salesforce-${portalType}-${args.id}`,
    title: "Open in Wolfpack portal",
    url: `/portal/salesforce/${portalType}/${encodeURIComponent(args.id)}`,
    type: "portal",
  };
}
