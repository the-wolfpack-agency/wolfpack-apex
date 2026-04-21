import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { listUpcomingMeetings } from "@/lib/meetings/upcoming";

/**
 * GET /api/meetings/upcoming
 *
 * Returns the caller's upcoming (and just-ended) meetings inside a
 * sensible window. The dashboard MeetingPreBriefPanel uses this to
 * populate its meeting selector and default the shown prebrief.
 *
 * Query params:
 *   ?hours=24         → how far ahead to look (default 48, clamped 1-168)
 *   ?lookback=30      → how far back to include just-ended meetings
 *                        (default 30 min, clamped 0-180)
 *   ?limit=20         → max meetings returned (default 20, clamped 1-50)
 *
 * Analytics: fires `meeting.upcoming_fetched` on success so the learning
 * loop can track dashboard meeting volume without needing to replay
 * Graph calls.
 */
export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "meetings.view");
  if (!auth.ok) return auth.response;
  const { user } = auth;

  const url = new URL(req.url);

  const hoursRaw = Number(url.searchParams.get("hours") ?? 48);
  const lookbackRaw = Number(url.searchParams.get("lookback") ?? 30);
  const limitRaw = Number(url.searchParams.get("limit") ?? 20);

  const lookaheadHours = clamp(
    Number.isFinite(hoursRaw) ? hoursRaw : 48,
    1,
    168,
  );
  const lookbackMinutes = clamp(
    Number.isFinite(lookbackRaw) ? lookbackRaw : 30,
    0,
    180,
  );
  const limit = clamp(Number.isFinite(limitRaw) ? limitRaw : 20, 1, 50);

  const meetings = await listUpcomingMeetings(user.id, {
    lookaheadHours,
    lookbackMinutes,
    limit,
  });

  trackEvent("meeting.upcoming_fetched", user.id, user.role, {
    count: meetings.length,
    lookahead_hours: lookaheadHours,
    lookback_minutes: lookbackMinutes,
    in_progress_count: meetings.filter((m) => m.inProgress).length,
  });

  return NextResponse.json({ meetings });
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}
