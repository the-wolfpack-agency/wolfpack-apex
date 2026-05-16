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
  try {
    const user = getUserFromRequest(req.headers.get("authorization"));
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const workspaceId = (user as { workspaceId?: string }).workspaceId ?? "default";
    const { id } = await ctx.params;

    const repo = createRepo();
    const source = await repo.getSource(id, workspaceId);
    if (!source) return NextResponse.json({ error: "not_found" }, { status: 404 });
    /* Reconcile stuck jobs BEFORE returning so the UI sees consistent
     * state. Jobs older than 6 minutes still marked 'running' are
     * almost certainly killed by Vercel mid-sync; mark them failed
     * so the poll loop stops and the operator sees what happened.
     * 6 min > the function maxDuration (300s) by a 60s buffer. */
    await repo.reconcileStuckJobs(6);
    const jobs = await repo.listJobsForSource(id, 20);
    return NextResponse.json({ source, jobs });
  } catch (err) {
    console.error("[connectors/sharepoint/sources/[id] GET] uncaught error:", err);
    return NextResponse.json(
      { error: `Couldn't load source: ${(err as Error)?.message ?? "unknown"}` },
      { status: 500 },
    );
  }
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
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
  } catch (err) {
    console.error("[connectors/sharepoint/sources/[id] DELETE] uncaught error:", err);
    return NextResponse.json(
      { error: `Couldn't remove source: ${(err as Error)?.message ?? "unknown"}` },
      { status: 500 },
    );
  }
}
