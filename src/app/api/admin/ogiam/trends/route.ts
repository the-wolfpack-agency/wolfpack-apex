/**
 * GET /api/admin/ogiam/trends: governance DRIFT TRENDS read surface.
 *
 * Governance has to be operational over time, not a one-shot snapshot. This route
 * returns day-bucketed time series of the three governance signals so the admin
 * trends view can render the renewal story (the line goes down and stays down):
 *   - gate-decision volume + would-block mix over time   (ogiam_decisions)
 *   - red-team pass-rate history                          (instinct_ai_redteam_runs)
 *   - ungoverned-AI-surface count over time               (instinct_ai_surfaces)
 *
 * Query params:
 *   window  : 1..365, default 30 (days back)
 *
 * Capability: settings.manage_team (same gate as the OGIAM decision explorer).
 * Workspace-scoped: every series is computed only over the caller's workspace.
 * Read-only (GET): no audit-allowlist entry needed. Fires ogiam.trends_viewed.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { governanceTrends, clampWindowDays } from "@/lib/ogiam/trends";

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const rawWindow = url.searchParams.get("window");
  const windowDays = clampWindowDays(
    rawWindow === null ? undefined : Number(rawWindow),
  );
  const workspaceId = auth.user.workspaceId ?? "default";

  /* The trends queries degrade to empty series on both "no rows" and "db
     unavailable" (safeQuery). If there is no DATABASE_URL the trends view cannot
     be served from real data, so surface 503 rather than a misleading flat-zero
     chart. Mirrors the decisions route. */
  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      { error: "Database temporarily unavailable." },
      { status: 503 },
    );
  }

  const trends = await governanceTrends(workspaceId, windowDays);

  trackEvent("ogiam.trends_viewed", auth.user.id, auth.user.role, {
    window_days: trends.window_days,
    buckets:
      trends.decisions.length + trends.redteam.length + trends.surfaces.length,
    source: "admin_ogiam",
  });

  return NextResponse.json({
    workspace_id: workspaceId,
    ...trends,
  });
}
