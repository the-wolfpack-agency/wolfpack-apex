/**
 * Upcoming meetings — thin wrapper over fetchCalendarEvents that returns
 * the user's meetings inside a usable window (default: -30 min to +48h)
 * and tags each one with `minutesUntil` so the dashboard prebrief panel
 * can show "starts in 3h 12m" / "ended 12m ago" without recomputing on
 * the client.
 *
 * Kept pure + side-effect-free (no analytics here). The /api route and
 * the client panel own their own trackEvent calls.
 */

import { fetchCalendarEvents, type CalendarEvent } from "@/lib/microsoft-graph";

export interface UpcomingMeeting {
  id: string;
  subject: string;
  start: string;
  end: string;
  location: string;
  attendees: string[];
  isOnlineMeeting: boolean;
  /** Negative = already started. Null = start time unparseable. */
  minutesUntil: number | null;
  /** True if the meeting is happening right now (start <= now < end). */
  inProgress: boolean;
}

export interface ListUpcomingOptions {
  /** How far back to look (for "just ended" follow-up surfaces). Default: 30 min. */
  lookbackMinutes?: number;
  /** How far ahead to look. Default: 48 h. */
  lookaheadHours?: number;
  /** Max meetings returned (sorted soonest-first). Default: 20. */
  limit?: number;
  /** Override "now" — for tests. Default: Date.now(). */
  nowMs?: number;
}

function minutesBetween(fromMs: number, iso: string): number | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.round((t - fromMs) / 60_000);
}

/**
 * Returns upcoming (and just-ended) meetings for `userId`, sorted by
 * start time ascending. Empty array on any transport error — the
 * dashboard prefers an empty tile to a broken one.
 */
export async function listUpcomingMeetings(
  userId: string,
  opts: ListUpcomingOptions = {},
): Promise<UpcomingMeeting[]> {
  const lookbackMinutes = opts.lookbackMinutes ?? 30;
  const lookaheadHours = opts.lookaheadHours ?? 48;
  const limit = opts.limit ?? 20;
  const nowMs = opts.nowMs ?? Date.now();

  const startIso = new Date(nowMs - lookbackMinutes * 60_000).toISOString();
  const endIso = new Date(nowMs + lookaheadHours * 60 * 60_000).toISOString();

  let events: CalendarEvent[] = [];
  try {
    events = await fetchCalendarEvents(userId, startIso, endIso);
  } catch {
    return [];
  }

  const out: UpcomingMeeting[] = [];
  for (const e of events) {
    const startMs = Date.parse(e.start);
    const endMs = Date.parse(e.end);
    // Skip events we can't order at all.
    if (Number.isNaN(startMs)) continue;
    // Drop anything that already ended before our lookback window — the
    // calendar provider may return recurring masters or overrun series.
    if (!Number.isNaN(endMs) && endMs < nowMs - lookbackMinutes * 60_000) continue;
    const minutesUntil = minutesBetween(nowMs, e.start);
    const inProgress =
      !Number.isNaN(startMs) &&
      !Number.isNaN(endMs) &&
      startMs <= nowMs &&
      endMs > nowMs;
    out.push({
      id: e.id,
      subject: e.subject,
      start: e.start,
      end: e.end,
      location: e.location,
      attendees: e.attendees,
      isOnlineMeeting: e.isOnlineMeeting,
      minutesUntil,
      inProgress,
    });
  }

  out.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return out.slice(0, limit);
}

/**
 * Pick the "most relevant" meeting from a list for the default prebrief
 * selection: prefer in-progress, else the next upcoming, else the most
 * recently ended. Returns null if the list is empty.
 */
export function pickDefaultMeeting(
  meetings: UpcomingMeeting[],
): UpcomingMeeting | null {
  if (meetings.length === 0) return null;
  const inProgress = meetings.find((m) => m.inProgress);
  if (inProgress) return inProgress;
  // Tolerate unsorted input — callers can pass meetings in any order.
  const upcoming = [...meetings]
    .filter((m) => typeof m.minutesUntil === "number" && m.minutesUntil >= 0)
    .sort((a, b) => (a.minutesUntil ?? Infinity) - (b.minutesUntil ?? Infinity))[0];
  if (upcoming) return upcoming;
  // Only recently-ended meetings remain; return the one that ended most
  // recently (largest negative minutesUntil).
  const recent = [...meetings]
    .filter((m) => typeof m.minutesUntil === "number")
    .sort((a, b) => (b.minutesUntil ?? -Infinity) - (a.minutesUntil ?? -Infinity));
  return recent[0] ?? meetings[0];
}
