/**
 * GET /api/planner/plans — list plans for the caller.
 *   - If ?groupId= is present, returns plans for that group (cache).
 *   - Otherwise returns all cached plans (group + roster).
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { listCachedPlans } from "@/lib/integrations/microsoft-planner";
import { trackEvent } from "@/lib/analytics";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const groupId = url.searchParams.get("groupId");

  const plans = await listCachedPlans(user.id, { groupId: groupId || undefined });
  trackEvent("system.page_viewed", user.id, user.role, {
    endpoint: "planner.plans",
    count: plans.length,
    filter: groupId ? "group" : "all",
  });
  return NextResponse.json({ plans });
}
