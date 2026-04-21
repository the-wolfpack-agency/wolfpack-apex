/**
 * GET /api/goals
 *
 * Composite read for the /goals page + GoalsDashboardTile.
 * Returns:
 *   - okrs: active OKRs with nested KRs (via goals.getActiveOKRs)
 *   - north_star: latest snapshot + history (via goals-north-star.getNorthStarTrend)
 *
 * Optional query params:
 *   - quarter=YYYY-QN  restrict active OKR fetch to one quarter
 *   - north_star_label pass through to trend fetcher
 *   - north_star_limit default 14
 *
 * Auth: getUserFromRequest (401 unauth). Read-only, so open to every role.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getActiveOKRs } from "@/lib/goals";
import { getNorthStarTrend } from "@/lib/goals-north-star";
import { trackEvent } from "@/lib/analytics";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const quarter = req.nextUrl.searchParams.get("quarter") ?? undefined;
  const nsLabel = req.nextUrl.searchParams.get("north_star_label") ?? undefined;
  const nsLimitRaw = req.nextUrl.searchParams.get("north_star_limit");
  const nsLimit = nsLimitRaw ? Number(nsLimitRaw) : undefined;

  const [okrs, northStar] = await Promise.all([
    getActiveOKRs({ quarter }),
    getNorthStarTrend({ label: nsLabel, limit: nsLimit }),
  ]);

  trackEvent("goal.page_viewed", user.id, user.role, { page: "api.goals" });

  return NextResponse.json({
    okrs,
    north_star: {
      latest: northStar.latest,
      history: northStar.history,
    },
  });
}
