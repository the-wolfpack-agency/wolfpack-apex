/**
 * GET    /api/connectors/sharepoint/sources/[id]      single source + recent jobs
 * DELETE /api/connectors/sharepoint/sources/[id]      soft-delete (is_active = false)
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { createRepo } from "@/lib/connectors/sharepoint/repo";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspaceId = (user as { workspaceId?: string }).workspaceId ?? "default";
  const { id } = await ctx.params;

  const repo = createRepo();
  const source = await repo.getSource(id, workspaceId);
  if (!source) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const jobs = await repo.listJobsForSource(id, 20);
  return NextResponse.json({ source, jobs });
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspaceId = (user as { workspaceId?: string }).workspaceId ?? "default";
  const { id } = await ctx.params;

  const repo = createRepo();
  const ok = await repo.deactivateSource(id, workspaceId);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });

  trackEvent("connectors.sharepoint.source_removed", user.id, user.role, {
    source_id: id,
    workspace_id: workspaceId,
  });
  return NextResponse.json({ ok: true });
}
