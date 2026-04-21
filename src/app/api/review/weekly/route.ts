/**
 * GET /api/review/weekly
 *
 * Returns the Mon→Sun retrospective for the caller. `?weekStart=YYYY-MM-DD`
 * accepts any day in the target week; the server snaps it to the Monday
 * of that week. Default is the Monday of the current UTC week.
 *
 * Fires one `review.weekly_computed` per call (for the learning loop) and
 * one `review.slip_detected` per slipped task (so the learning loop can
 * count how often we're surfacing slips per user per week).
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { computeWeeklyReview, mondayOf } from "@/lib/review/weekly";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const weekStartParam = url.searchParams.get("weekStart");

  let weekStart: Date;
  if (weekStartParam) {
    const parsed = new Date(`${weekStartParam}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ error: "Invalid weekStart" }, { status: 400 });
    }
    weekStart = mondayOf(parsed);
  } else {
    weekStart = mondayOf(new Date());
  }

  const review = await computeWeeklyReview(user.id, weekStart);

  trackEvent("review.weekly_computed", user.id, user.role, {
    week_start: review.weekStart,
    week_end: review.weekEnd,
    meetings_attended: review.meetingsAttended,
    tasks_closed: review.tasksClosed,
    tasks_opened: review.tasksOpened,
    unanswered_flagged: review.unansweredFlagged,
    slip_count: review.slips.length,
  });

  for (const slip of review.slips) {
    trackEvent("review.slip_detected", user.id, user.role, {
      week_start: review.weekStart,
      task_id: slip.id,
      reason: slip.reason,
      due_at: slip.dueAt ?? "",
    });
  }

  return NextResponse.json(review);
}
