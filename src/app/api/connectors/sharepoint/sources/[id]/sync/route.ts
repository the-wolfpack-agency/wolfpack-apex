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

/* Maximize background-execution window on Vercel so large folders
 * (training videos, etc.) have a chance to complete. The route itself
 * returns 202 in well under a second; this allotment is for the
 * fire-and-forget syncSource() that runs after the response is sent. */
export const maxDuration = 300;

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

    /* Fire-and-forget so the HTTP response returns immediately. The
     * caller polls GET /sources/[id] for job status. Without this,
     * Vercel's 60-second function timeout would 504 us mid-sync on
     * any folder with more than a handful of large files (training
     * videos in particular), and the UI would show an "Unexpected
     * token <" HTML parse error. */
    void syncSource(source, user.id, user.role).catch((err) => {
      /* syncSource handles per-file failures internally; this catch
       * is for catastrophic crashes (e.g. token revocation mid-run).
       * The job row stays at status='running' until a reconciler
       * sweeps it up — a TODO follow-up. */
      console.error(
        "[connectors/sharepoint/sync] background syncSource crashed:",
        err,
      );
    });

    return NextResponse.json(
      { accepted: true, sourceId: id },
      { status: 202 },
    );
  } catch (err) {
    console.error("[connectors/sharepoint/sync POST] uncaught error:", err);
    return NextResponse.json(
      { error: `Sync failed unexpectedly: ${(err as Error)?.message ?? "unknown"}` },
      { status: 500 },
    );
  }
}
