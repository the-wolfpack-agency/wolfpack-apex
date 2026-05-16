/**
 * POST /api/connectors/sharepoint/sources/[id]/sync
 *
 * Trigger a sync run for the given source. Synchronous for now (small
 * folders complete in seconds). Larger folders would warrant a queued
 * background worker, but the existing brain-ingest pipeline is the
 * bottleneck and it's already async-friendly.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { createRepo } from "@/lib/connectors/sharepoint/repo";
import { syncSource } from "@/lib/connectors/sharepoint/sync";

export async function POST(
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
    if (!source.isActive) return NextResponse.json({ error: "source_inactive" }, { status: 410 });

    const result = await syncSource(source, user.id, user.role);
    const httpStatus = result.status === "failed" ? 502 : 200;
    return NextResponse.json({ result }, { status: httpStatus });
  } catch (err) {
    /* syncSource itself catches per-file failures and never throws,
     * but downloads to /content can throw on network issues that
     * bubble past the inner try/catch. Always return JSON. */
    console.error("[connectors/sharepoint/sync POST] uncaught error:", err);
    return NextResponse.json(
      { error: `Sync failed unexpectedly: ${(err as Error)?.message ?? "unknown"}` },
      { status: 500 },
    );
  }
}
