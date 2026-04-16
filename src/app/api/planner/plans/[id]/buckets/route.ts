/**
 * GET /api/planner/plans/[id]/buckets — list buckets for a plan.
 * `id` accepts local UUID OR Graph plan id.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { listBuckets } from "@/lib/integrations/microsoft-planner";
import { trackEvent } from "@/lib/analytics";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const result = await listBuckets(user.id, id);
  if (!result.ok) {
    const status =
      result.code === "not_connected" ? 401 :
      result.code === "scope_missing" ? 403 :
      result.code === "not_found" ? 404 :
      result.code === "rate_limited" ? 429 :
      result.status ?? 502;
    return NextResponse.json(
      { error: result.code, scope: result.scope, message: result.message },
      { status },
    );
  }
  trackEvent("system.page_viewed", user.id, user.role, {
    endpoint: "planner.buckets",
    plan_id: id,
    count: result.value.length,
  });
  return NextResponse.json({ buckets: result.value });
}
