/**
 * POST /api/connectors/sharepoint/sync-all
 *
 * Index the whole granted SharePoint estate: walk every ACTIVE connected source
 * for the caller's workspace and sync each. Synchronous, like the per-source
 * route (the `after()` background pattern left jobs stuck at running in this
 * deployment). Bounded by the orchestrator's own wall-clock budget, so it
 * returns cleanly within maxDuration and is safe to press again to continue a
 * large estate — every already-landed file is skipped by drive-item id.
 *
 * Operator-gated: syncing the whole estate is heavier than the per-source sync,
 * so it requires `settings.manage_team` — the same capability the admin
 * connectors route uses. requireCapability returns 401 unauthenticated and 403
 * without the capability, and the workspace comes from the session (never the
 * request), so a privileged user cannot sync another tenant's estate.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { syncAllSources } from "@/lib/connectors/sharepoint/sync-all";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const auth = await requireCapability(req, "settings.manage_team");
    if (!auth.ok) return auth.response;
    const user = auth.user;
    const workspaceId = user.workspaceId;

    const result = await syncAllSources(workspaceId, user.id, user.role);

    // 200 whenever the run completed and wrote its summary, even if some sources
    // failed: partial estate progress is a success for this endpoint, and the
    // per-source failures are itemized in `result.sources` for the UI. 502 only
    // if literally nothing could be processed AND at least one source errored.
    const nothingWorked =
      result.sourcesProcessed > 0 &&
      result.sourcesSucceeded === 0 &&
      result.sourcesFailed === result.sourcesProcessed;
    return NextResponse.json({ result }, { status: nothingWorked ? 502 : 200 });
  } catch (err) {
    console.error("[connectors/sharepoint/sync-all POST] uncaught error:", err);
    return NextResponse.json(
      { error: `Estate sync failed unexpectedly: ${(err as Error)?.message ?? "unknown"}` },
      { status: 500 },
    );
  }
}
