/**
 * GET /api/admin/ogiam/verify: chain verification + latest checkpoint for
 * the caller's workspace.
 *
 * Surfaces the OGIAM notarization state to the explorer banner: did the
 * decision chain verify end to end, and is its head notarized by a signed
 * checkpoint. verifyChain recomputes every entry hash from the stored
 * canonical payload, so an after-the-fact edit or deletion is detected.
 *
 * Capability: settings.manage_team (same gate as the decisions explorer).
 * Both reads go through safeQuery and degrade gracefully, so this route
 * never 500s on a missing DB.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { verifyChain, latestCheckpoint } from "@/lib/ogiam/checkpoint";

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const workspaceId = auth.user.workspaceId ?? "default";

  return NextResponse.json({
    workspace_id: workspaceId,
    verification: await verifyChain(workspaceId),
    checkpoint: await latestCheckpoint(workspaceId),
  });
}
