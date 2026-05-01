/**
 * GET /api/principles/reports/latest
 *
 * Leadership-only. Returns the most recent weekly report markdown so
 * the /principles team-tab UI can render it as a banner / preview.
 * 403 for everyone except ceo / cto (no audit log — this is a
 * leadership-shared aggregate, not per-member evidence).
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { canReadTeamEvidence } from "@/lib/principles/authz";
import { getLatestWeeklyReport } from "@/lib/principles/weekly-report";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!canReadTeamEvidence({ id: user.id, role: user.role })) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const report = await getLatestWeeklyReport();
  if (!report) {
    return NextResponse.json({ report: null });
  }
  return NextResponse.json({ report });
}
