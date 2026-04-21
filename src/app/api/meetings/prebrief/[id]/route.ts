import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { computePrebrief } from "@/lib/meetings/prebrief";

/**
 * GET /api/meetings/prebrief/[id]
 *
 * Returns a composed pre-brief for the caller's meeting with the given
 * calendar id. 401 if unauth, 403 if capability missing, 404 if the
 * meeting isn't in the caller's fetched calendar window, 200 otherwise.
 *
 * Analytics: fires `meeting.prebrief_computed` on success so the
 * learning loop can group by meeting_id and count coverage.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "meetings.view");
  if (!auth.ok) return auth.response;
  const { user } = auth;

  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  const result = await computePrebrief(user.id, id);
  if (!result) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  trackEvent("meeting.prebrief_computed", user.id, user.role, {
    meeting_id: id,
    attendee_count: result.attendeeEmails.length,
    thread_count: result.recentThreads.length,
    open_task_count: result.openTasks.length,
    has_linked_goal: result.linkedGoal !== null,
  });

  return NextResponse.json(result);
}
