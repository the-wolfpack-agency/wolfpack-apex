/**
 * GET /api/admin/site-analytics?days=30
 *
 * Capability-gated read of the OGIAM marketing-site usage telemetry for the
 * admin Site Analytics page. Returns the aggregated summary (by hour of day,
 * top pages, top countries, totals). No PII in the store, so none here.
 *
 *   200 { summary }
 *   401 / 403 via requireCapability("analytics.view")
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getSiteAnalyticsSummary } from "@/lib/site-analytics";

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "analytics.view");
  if (!auth.ok) return auth.response;

  const daysRaw = new URL(req.url).searchParams.get("days");
  const days = daysRaw ? Number(daysRaw) : 30;

  const summary = await getSiteAnalyticsSummary(days, auth.user.workspaceId);
  // The read is now org-wide (analytics.view is in SELF_SERVICE), but the write
  // actions on the page stay gated. Tell the client which controls the caller
  // may use so a viewer never sees a button that would 403 (a UI defect).
  const permissions = {
    triage: auth.capabilities.has("analytics.triage"),
    manageOperators: auth.capabilities.has("settings.manage_team"),
  };
  return NextResponse.json({ summary, permissions });
}
