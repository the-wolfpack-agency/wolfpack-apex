import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest, hasRole } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { generateBriefing } from "@/lib/morning-briefing";

/**
 * GET /api/briefing
 *
 * Returns the morning briefing for the authenticated CEO/CTO.
 *
 * Query params:
 *   ?refresh=true — Force regenerate (bypass 30-minute cache)
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!hasRole(user.role, "cto")) {
    return NextResponse.json(
      { error: "Forbidden — CEO/CTO access required" },
      { status: 403 },
    );
  }

  const url = new URL(req.url);
  const forceRefresh = url.searchParams.get("refresh") === "true";

  trackEvent("briefing.viewed", user.id, user.role, { refresh: forceRefresh });

  if (forceRefresh) {
    trackEvent("briefing.refreshed", user.id, user.role, {});
  }

  const briefing = await generateBriefing(user.id, user.role, {
    force: forceRefresh,
    userName: user.name.split(" ")[0],
  });

  return NextResponse.json(briefing);
}
