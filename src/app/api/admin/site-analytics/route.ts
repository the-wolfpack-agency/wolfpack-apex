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

  const sp = new URL(req.url).searchParams;
  const daysRaw = sp.get("days");
  const days = daysRaw ? Number(daysRaw) : 30;
  // Per-site filter. Bounded to a short slug so an arbitrary value can't reach
  // the query as anything but a bind parameter; unknown values simply match no
  // rows. Defaults to "all" (the cross-site view).
  const surfaceRaw = sp.get("surface");
  const surface = surfaceRaw && /^[a-z0-9.\-_]{1,64}$/i.test(surfaceRaw) ? surfaceRaw : "all";

  const full = await getSiteAnalyticsSummary(days, auth.user.workspaceId, surface);
  const viewIntel = auth.capabilities.has("forcefield.view");
  // The read is now org-wide (analytics.view is in SELF_SERVICE), but the write
  // actions on the page stay gated. Tell the client which controls the caller
  // may use so a viewer never sees a button that would 403 (a UI defect).
  const permissions = {
    triage: auth.capabilities.has("analytics.triage"),
    manageOperators: auth.capabilities.has("settings.manage_team"),
    // The deep agent-defense intel (operator dossiers, campaigns, tradecraft,
    // reputation network, probe/payload) is scoped to forcefield.view. Site usage
    // + the high-level Forcefield summary stay org-wide (analytics.view) by design.
    viewIntel,
  };
  // Deep intel is returned ONLY to forcefield.view holders. Everyone else gets an
  // allowlist of site usage + the high-level Forcefield summary - allowlist, not
  // denylist, so a future intel field can never leak by being forgotten here.
  const summary = viewIntel
    ? full
    : {
        rangeDays: full.rangeDays,
        surfaces: full.surfaces,
        totalPageViews: full.totalPageViews,
        collectsPageViews: full.collectsPageViews,
        totalEvents: full.totalEvents,
        byHour: full.byHour,
        byPage: full.byPage,
        byCountry: full.byCountry,
        byType: full.byType,
        forcefield: full.forcefield,
        agentOrigins: full.agentOrigins,
      };
  return NextResponse.json({ summary, permissions });
}
