/**
 * Shared server helpers for /api/portal/salesforce/* routes.
 *
 * Centralizes:
 *   - Object-type validation (only contacts/opportunities/accounts in
 *     the MVP; anything else 400s before we touch the connector).
 *   - The list → connector object-type translation (the portal URLs use
 *     plural English "contacts" but the connector + presets use singular
 *     `contact` / `deal` (for opportunity) / `account`).
 *   - The "instanceUrl" extraction the drill-in page uses to render an
 *     "Open in Salesforce" link. The baseUrl saved in
 *     instinct_connector_credentials IS the org's My Domain root for
 *     Salesforce, so we just return it.
 *
 * Pattern matches src/lib/assistant/connectors/credentials.ts —
 * server-side never trusts a body workspaceId; everything is resolved
 * from the auth session.
 */

import {
  buildRestConnectorForWorkspace,
  pickConfiguredConnector,
} from "@/lib/assistant/connectors";
import type { RestConnector } from "@/lib/assistant/connectors/rest-connector";
import { loadConnectorCredentials } from "@/lib/assistant/connectors/credentials";

/* Portal-visible types. The dashboard URL "/portal/salesforce/contacts"
   uses the plural form for readability; the connector wants the
   singular and uses "deal" as an alias for "opportunity". */
export const PORTAL_TYPES = ["contacts", "opportunities", "accounts"] as const;
export type PortalType = (typeof PORTAL_TYPES)[number];

export function isPortalType(value: unknown): value is PortalType {
  return (
    typeof value === "string" &&
    (PORTAL_TYPES as readonly string[]).includes(value)
  );
}

/* Map the URL/plural form to the connector's lowercase singular. The
   connector + vendor preset both accept "opportunity" or "deal" for
   Salesforce Opportunities; we use "opportunity" so the field set
   (StageName/Amount/CloseDate) matches what we render. */
export function portalTypeToObject(t: PortalType): string {
  switch (t) {
    case "contacts":
      return "contact";
    case "opportunities":
      return "opportunity";
    case "accounts":
      return "account";
  }
}

/* Display labels for breadcrumbs / titles / record headers. */
export function portalTypeLabel(t: PortalType): string {
  switch (t) {
    case "contacts":
      return "Contact";
    case "opportunities":
      return "Opportunity";
    case "accounts":
      return "Account";
  }
}

export interface ResolvedConnector {
  connectorName: string;
  connector: RestConnector;
  /** True when the workspace has no Salesforce row configured. Pages
   *  render a "Connect Salesforce" CTA instead of hitting the API. */
  notConfigured: boolean;
  /** Org base URL stored in credentials. Used for "Open in Salesforce"
   *  links — the recordUrl is just `${instanceUrl}/${id}` for SF. */
  instanceUrl: string | null;
}

/** Resolve the connector for the caller's workspace, preferring a
 *  configured `salesforce` row. Falls back to `rest-default` when the
 *  workspace hasn't run Quick Connect yet — the page renders the
 *  not-configured CTA in that case so we never blast the generic
 *  rest-default at SF-shaped queries. */
export async function resolveSalesforceConnector(
  workspaceId: string,
): Promise<ResolvedConnector> {
  const preferred = await pickConfiguredConnector(workspaceId);
  /* The portal is Salesforce-specific by design — only a `salesforce`
     row resolves as configured. A workspace that has only the generic
     `rest-default` (or no row at all) renders the connect CTA. */
  const connectorName = preferred === "salesforce" ? "salesforce" : "salesforce";
  const connector = await buildRestConnectorForWorkspace(
    workspaceId,
    connectorName,
  );
  const creds = await loadConnectorCredentials(workspaceId, connectorName);
  return {
    connectorName,
    connector,
    notConfigured: !connector.isConfigured(),
    instanceUrl: creds?.baseUrl ?? null,
  };
}

/** Map a connector code → typed API error response code. Reused by every
 *  route so the UI can branch consistently. */
export function connectorErrorToHttp(
  code: string | undefined,
): { status: number; body: { error: string; code: string } } {
  switch (code) {
    case "auth_failed":
      return { status: 502, body: { error: "Salesforce auth failed — reconnect from /admin/connectors", code: "auth_failed" } };
    case "rate_limited":
      return { status: 429, body: { error: "Salesforce rate-limited; try again in a moment", code: "rate_limited" } };
    case "not_found":
      return { status: 404, body: { error: "Record not found", code: "not_found" } };
    case "network":
      return { status: 502, body: { error: "Network error reaching Salesforce", code: "network" } };
    case "remote_error":
      return { status: 502, body: { error: "Salesforce returned an error", code: "remote_error" } };
    case "not_configured":
      return { status: 412, body: { error: "Salesforce connector not configured", code: "not_configured" } };
    case "validation":
      return { status: 400, body: { error: "Validation failure from connector", code: "validation" } };
    default:
      return { status: 500, body: { error: "Salesforce connector error", code: code ?? "internal" } };
  }
}
