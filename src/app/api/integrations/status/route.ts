import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getConnectionStatus as getMsStatus } from "@/lib/microsoft-graph";
import { getConnectionStatus as getQboStatus } from "@/lib/quickbooks";
import {
  getConnectionStatus as getPlaudStatus,
  isPlaudConfigured,
} from "@/lib/plaud";
import { listConnectorCredentials } from "@/lib/assistant/connectors";

/**
 * GET /api/integrations/status
 *
 * Aggregate connection status across all third-party integrations.
 * Consumers (Tasks page, Planner page, AssistantStarterPrompts) gate
 * UI on `<provider>.connected`. Originally the endpoint did not exist
 * and the fetch quietly 404'd, pinning users to "Connect Microsoft To
 * Do" empty state even after a successful OAuth handshake.
 *
 * Response shape is intentionally nested per provider so new
 * integrations can add themselves without breaking existing
 * consumers. `connected: boolean` is the contract.
 *
 * salesforce/hubspot/github are workspace-level (not per-user) so
 * they're derived from credential rows + env vars, not OAuth state.
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [microsoft, quickbooks, plaud, connectorRows] = await Promise.all([
    getMsStatus(user.id).catch(() => ({ connected: false, mode: "live" as const })),
    getQboStatus().catch(() => ({ connected: false })),
    getPlaudStatus().catch(() => ({ connected: false })),
    listConnectorCredentials(user.workspaceId).catch(() => []),
  ]);

  const salesforceConnected = connectorRows.some(
    (r) => r.connectorName === "salesforce" && r.isActive,
  );
  const hubspotConnected = connectorRows.some(
    (r) => r.connectorName === "hubspot" && r.isActive,
  );
  const githubConnected = !!process.env.GITHUB_TOKEN_WOLFPACK_AGENCY;

  return NextResponse.json({
    microsoft,
    quickbooks,
    plaud: { ...plaud, configured: isPlaudConfigured() },
    salesforce: { connected: salesforceConnected },
    hubspot: { connected: hubspotConnected },
    github: { connected: githubConnected },
  });
}
