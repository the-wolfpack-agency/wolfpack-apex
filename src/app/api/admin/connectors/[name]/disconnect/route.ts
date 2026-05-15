/**
 * POST /api/admin/connectors/[name]/disconnect
 *
 * Soft-deletes the workspace's credential row for this connector by
 * setting is_active=false. Tools that load credentials filter by
 * is_active=TRUE so a disconnected connector silently falls back to
 * env defaults (or "not configured").
 *
 * Why soft-delete rather than DELETE: the refresh-token + provider
 * metadata are useful audit history; nuking them on every disconnect
 * loses the "we used to be connected, here's when" timeline. To
 * reconnect, the admin just runs the OAuth /start flow again — the
 * INSERT … ON CONFLICT path in saveOAuthCredentials flips is_active
 * back to TRUE + rotates the tokens.
 *
 * Auth: settings.manage_team (same gate as create).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";

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
  let affected = 0;
  try {
    const r = await safeQuery<{ count: number }>(
      `WITH updated AS (
         UPDATE instinct_connector_credentials
            SET is_active = FALSE, updated_at = now()
          WHERE workspace_id = $1
            AND connector_name = $2
            AND is_active = TRUE
          RETURNING 1
       )
       SELECT COUNT(*)::int AS count FROM updated`,
      [workspaceId, connectorName],
    );
    affected = r.rows[0]?.count ?? 0;
  } catch (err) {
    trackEvent("assistant.connector_disconnect_failed", auth.user.id, auth.user.role, {
      connector: connectorName,
      workspace_id: workspaceId,
      reason: (err as Error)?.message ?? "unknown",
    });
    return NextResponse.json({ error: "disconnect_failed" }, { status: 500 });
  }

  if (affected === 0) {
    return NextResponse.json(
      { ok: false, error: "not_found", message: "No active connector with that name" },
      { status: 404 },
    );
  }

  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "connector.credentials.disconnected",
    resourceType: "connector_credentials",
    resourceId: `${workspaceId}:${connectorName}`,
    afterState: { workspace_id: workspaceId, connector_name: connectorName, is_active: false },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  trackEvent("assistant.connector_disconnected", auth.user.id, auth.user.role, {
    connector: connectorName,
    workspace_id: workspaceId,
  });

  return NextResponse.json({ ok: true });
}
