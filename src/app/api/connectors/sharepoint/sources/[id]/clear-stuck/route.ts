/**
 * POST /api/connectors/sharepoint/sources/[id]/clear-stuck
 *
 * Force-marks every 'running' ingest job for this source as 'failed'
 * with a manual-clear error message. Workspace-scoped so a user can
 * never clear another workspace's jobs. The operator can hit this
 * from the admin UI whenever a sync is stuck, without waiting for
 * the timestamp-based reconciler.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { query } from "@/lib/db";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = getUserFromRequest(req.headers.get("authorization"));
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const workspaceId = (user as { workspaceId?: string }).workspaceId ?? "default";
    const { id } = await ctx.params;

    /* Only clear jobs that belong to a source THIS workspace owns.
     * Two-step to avoid cross-workspace data leakage. */
    const ownership = await query<{ id: string }>(
      `SELECT id FROM instinct_sharepoint_sources
        WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId],
    );
    if (ownership.rows.length === 0) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const result = await query(
      `UPDATE instinct_sharepoint_ingest_jobs
          SET status = 'failed',
              ended_at = NOW(),
              error = 'manually cleared by operator'
        WHERE source_id = $1 AND status = 'running'`,
      [id],
    );
    return NextResponse.json({ cleared: result.rowCount ?? 0 });
  } catch (err) {
    console.error("[connectors/sharepoint/clear-stuck POST] uncaught error:", err);
    return NextResponse.json(
      { error: `Clear failed: ${(err as Error)?.message ?? "unknown"}` },
      { status: 500 },
    );
  }
}
