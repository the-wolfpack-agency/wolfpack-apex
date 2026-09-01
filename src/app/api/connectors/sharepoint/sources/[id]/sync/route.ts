/**
 * POST /api/connectors/sharepoint/sources/[id]/sync
 *
 * Synchronous sync: route awaits syncSource() before responding. The
 * `after()` background pattern was unreliable in this deployment
 * (jobs stayed at status='running' forever, which caused the admin
 * UI to busy-poll until it hit its cap). Synchronous is simpler and
 * actually works for any folder that completes within maxDuration.
 *
 * maxDuration = 300s gives most realiztic folders enough time. Truly
 * huge folders (terabytes, thousands of files) need a queue worker
 * which is a separate project.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { createRepo } from "@/lib/connectors/sharepoint/repo";
import { syncSource } from "@/lib/connectors/sharepoint/sync";

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

    /* Synchronous: actually wait for the sync to complete (or fail)
     * before responding. The result includes file/success/fail counts
     * so the UI can show a final status in one round trip. */
    const result = await syncSource(source, user.id, user.role);
    const httpStatus =
      result.status === "succeeded" ? 200 :
      result.status === "partial" ? 200 :
      502;
    return NextResponse.json({ result }, { status: httpStatus });
  } catch (err) {
    console.error("[connectors/sharepoint/sync POST] uncaught error:", err);
    return NextResponse.json(
      { error: `Sync failed unexpectedly: ${(err as Error)?.message ?? "unknown"}` },
      { status: 500 },
    );
  }
}
