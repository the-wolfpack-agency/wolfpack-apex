/**
 * GET /api/goals/weekly/:week_of — team commitments for one week.
 *
 * :week_of is YYYY-MM-DD (Monday of the week). Returns every teammate's
 * commitments for that week across all KRs. Used by the /goals page
 * sidebar + Friday sync view + GoalsDashboardTile team-summary.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getTeamCommitmentsForWeek } from "@/lib/goals-contributions";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ week_of: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { week_of } = await params;
  if (!week_of || !DATE_RE.test(week_of)) {
    return NextResponse.json(
      { error: "week_of must be YYYY-MM-DD" },
      { status: 400 },
    );
  }

  const commitments = await getTeamCommitmentsForWeek(week_of);
  return NextResponse.json({ week_of, commitments });
}
