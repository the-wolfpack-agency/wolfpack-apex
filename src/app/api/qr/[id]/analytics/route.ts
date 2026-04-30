/**
 * /api/qr/[id]/analytics — rollup of scan analytics for a single code.
 *
 * Returns the full QrAnalytics payload (totals, daily series, country
 * breakdown, device/browser/OS breakdown, hour-of-day, top referrers,
 * recent scans). The dashboard renders each panel directly.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { getAnalytics } from "@/lib/qr/scans";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;

  const analytics = await getAnalytics(id);

  trackEvent("assistant.qr_analytics_viewed", user.id, user.role, {
    code_id: id,
  });

  return NextResponse.json(analytics);
}
