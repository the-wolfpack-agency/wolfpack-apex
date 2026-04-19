/**
 * /api/clients/[id]/assets/[assetId] — per-asset operations.
 *
 * DELETE → soft-delete (flip deleted_at). Capability: `clients.edit`.
 *
 * GET is intentionally NOT implemented here; the list endpoint returns
 * everything the picker needs (metadata). Raw bytes come from
 * `.../[assetId]/raw`.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { softDeleteAsset, getAssetById } from "@/lib/client-assets";

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string; assetId: string }> },
) {
  const auth = await requireCapability(req, "clients.edit");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  const { id: clientSlug, assetId } = await context.params;

  // Confirm the asset belongs to the named client — prevents a logged-in
  // sales user from deleting another client's asset via id guessing.
  const existing = await getAssetById(assetId);
  if (!existing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (existing.clientSlug !== clientSlug) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  try {
    await softDeleteAsset(assetId, { userId: user.id, userRole: user.role });
  } catch (err) {
    const msg = (err as Error).message ?? "delete failed";
    console.error("[clients/assets DELETE]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  try {
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "client_asset.deleted",
      resourceType: "client_asset",
      resourceId: assetId,
      beforeState: {
        client_slug: clientSlug,
        kind: existing.assetKind,
        filename: existing.filename,
      },
      ...extractRequestMetadata(req),
    });
  } catch (err) {
    console.error("[clients/assets DELETE audit]", (err as Error).message);
  }

  return NextResponse.json({ ok: true });
}
