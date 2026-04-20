/**
 * GET /api/sites/insights/brief-edits?days=7
 *
 * Admin-only dashboard endpoint. Returns the aggregated BriefEditInsights
 * for the requested window (default 7 days, max 90). Pure read path —
 * the nightly script (scripts/brief-edit-insights-nightly.ts) writes
 * snapshots; this endpoint recomputes live so the dashboard always
 * reflects the current state of instinct_site_brief_edits.
 *
 * Role gate: hasRole(user.role, "hr") — ceo / cto / hr only. Sales + ops
 * have no business seeing per-user acceptance rates.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest, hasRole } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { computeBriefEditInsights } from "@/lib/brief-edit-learning";

const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;

function parseDays(raw: string | null): number {
  if (!raw) return DEFAULT_DAYS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, n);
}

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasRole(user.role, "hr")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const days = parseDays(searchParams.get("days"));

  try {
    const insights = await computeBriefEditInsights({ days });
    trackEvent("site.insights_viewed", user.id, user.role, {
      window_days: days,
      row_count: insights.window.rowCount,
    });
    return NextResponse.json({ insights });
  } catch (err) {
    console.error("[insights.brief-edits]", (err as Error).message);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
