/**
 * POST /api/admin/connectors/[name]/verify
 *
 * Health-check a connector by issuing a single low-cost read against
 * the vendor's API. Used by the admin UI's "Verify connection" affordance
 * — proves the stored tokens still work without waiting for a user
 * query.
 *
 * Strategy: call the connector's searchRecords with a 2-char query.
 * For Salesforce this fires a `SELECT … WHERE Name LIKE '%xx%' LIMIT 1`
 * SOQL — cheapest possible read. We don't care about the result, only
 * whether the call succeeded (proves the token works) or 401'd (proves
 * the token is dead and refresh failed). The connector's refresh-on-401
 * logic also fires here, so a verify call against a near-expired token
 * silently rotates it.
 *
 * Auth: settings.manage_team.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { buildRestConnectorForWorkspace } from "@/lib/assistant/connectors";
import { trackEvent } from "@/lib/analytics";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ name: string }> },
): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const { name } = await context.params;
  const connectorName = typeof name === "string" ? name : "";
  if (!connectorName) {
    return NextResponse.json({ error: "connector name required" }, { status: 400 });
  }

  const workspaceId = auth.user.workspaceId;
  const t0 = Date.now();
  const connector = await buildRestConnectorForWorkspace(workspaceId, connectorName);
  if (!connector.isConfigured()) {
    return NextResponse.json(
      { ok: false, code: "not_configured", message: "No active credentials for this connector" },
      { status: 404 },
    );
  }

  /* Cheap read — searchRecords with a 2-char query is the lowest-cost
     authenticated call we can issue. Any 2xx (even an empty result set)
     means the auth path works. */
  const probeQuery = "xx";
  const result = await connector.searchRecords("contact", probeQuery, 1);
  const tookMs = Date.now() - t0;

  trackEvent("assistant.connector_verified", auth.user.id, auth.user.role, {
    connector: connectorName,
    workspace_id: workspaceId,
    ok: result.ok,
    duration_ms: tookMs,
    code: result.ok ? "ok" : result.code ?? "unknown",
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        code: result.code,
        message: result.message ?? "verify_failed",
        duration_ms: tookMs,
      },
      { status: result.code === "auth_failed" ? 401 : 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    matched: (result.data ?? []).length,
    duration_ms: tookMs,
  });
}
