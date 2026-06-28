/**
 * /api/admin/gate/api-keys/[id] - revoke an external gate API key.
 *
 *   DELETE → revoke the key with this id, IF it belongs to the caller's
 *            workspace. Workspace-scoped: a privileged user in workspace A can't
 *            revoke a key in workspace B. Returns { revoked: boolean }.
 *
 * Capability: settings.manage_team (same gate as the mint/list route). Every
 * revoke is audit-logged.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { revokeApiKey } from "@/lib/ogiam/api-keys";

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const user = auth.user;
  const workspaceId = user.workspaceId;

  const { id } = await ctx.params;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const revoked = await revokeApiKey(id, workspaceId);

  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "gate.api_key.revoked",
    resourceType: "gate_api_key",
    resourceId: id,
    afterState: { workspace_id: workspaceId, id, revoked },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  return NextResponse.json({ revoked });
}
