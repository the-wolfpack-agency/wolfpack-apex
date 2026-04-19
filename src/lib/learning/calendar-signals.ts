/**
 * Calendar signals — read helpers over instinct_calendar_events_written.
 *
 * These are pure extractors; the Assistant + analytics brain compose
 * them into "your calendar was 87% full yesterday" style insights.
 *
 * TODO: consumer integrations once Stream A ships.
 */
 

import { safeQuery } from "@/lib/db";

export interface MeetingLoad {
  window_days: number;
  created_count: number;
  updated_count: number;
  deleted_count: number;
  total_minutes: number;
  avg_minutes_per_event: number;
  events_with_attendees: number;
}

export interface ContextSwitchScore {
  user_id: string;
  day: string; // ISO date
  event_count: number;
  back_to_back_count: number;
  /**
   * 0 = no switches. Higher = more fragmented day.
   * Scale: # of transitions * 10, capped at 100.
   */
  score: number;
}

/**
 * Aggregate calendar mutation activity for the user in the last
 * `windowDays`. Only considers `created` + `updated` events for the
 * minute totals (deleted events have NULL start/end).
 */
export async function getMeetingLoad(
  userId: string,
  windowDays: number = 7,
): Promise<MeetingLoad> {
  const result = await safeQuery<{
    action: string;
    count: string;
    total_minutes: string;
    events_with_attendees: string;
    avg_minutes: string;
  }>(
    `SELECT action,
            COUNT(*)::text AS count,
            COALESCE(SUM(
              EXTRACT(EPOCH FROM (end_at - start_at)) / 60
            ), 0)::text AS total_minutes,
            COALESCE(AVG(
              EXTRACT(EPOCH FROM (end_at - start_at)) / 60
            ), 0)::text AS avg_minutes,
            SUM(CASE
                  WHEN jsonb_array_length(COALESCE(attendees, '[]'::jsonb)) > 0
                  THEN 1 ELSE 0
                END)::text AS events_with_attendees
       FROM instinct_calendar_events_written
      WHERE user_id = $1
        AND performed_at > NOW() - INTERVAL '1 day' * $2
      GROUP BY action`,
    [userId, windowDays],
  );

  let created = 0;
  let updated = 0;
  let deleted = 0;
  let totalMinutes = 0;
  let eventsWithAttendees = 0;
  let avgMinutes = 0;
  let avgSamples = 0;

  for (const row of result.rows) {
    const count = parseInt(row.count, 10) || 0;
    if (row.action === "created") created = count;
    else if (row.action === "updated") updated = count;
    else if (row.action === "deleted") deleted = count;

    if (row.action !== "deleted") {
      totalMinutes += parseFloat(row.total_minutes) || 0;
      eventsWithAttendees += parseInt(row.events_with_attendees, 10) || 0;
      const avg = parseFloat(row.avg_minutes) || 0;
      if (avg > 0) {
        avgMinutes = (avgMinutes * avgSamples + avg) / (avgSamples + 1);
        avgSamples += 1;
      }
    }
  }

  return {
    window_days: windowDays,
    created_count: created,
    updated_count: updated,
    deleted_count: deleted,
    total_minutes: Math.round(totalMinutes),
    avg_minutes_per_event: avgMinutes > 0 ? Math.round(avgMinutes) : 0,
    events_with_attendees: eventsWithAttendees,
  };
}

/**
 * Compute a 0–100 "context switch" score for a given day based on
 * back-to-back meeting density. Meetings with <15m gaps are treated
 * as back-to-back. A user with 0 meetings scores 0; a user with 5
 * back-to-back meetings scores 50; 10+ saturates at 100.
 *
 * `day` may be "today", "yesterday", or an ISO date (YYYY-MM-DD).
 */
export async function getContextSwitchScore(
  userId: string,
  day: string = "today",
): Promise<ContextSwitchScore> {
  const dayISO = normalizeDay(day);

  const result = await safeQuery<{
    start_at: string;
    end_at: string;
  }>(
    `SELECT start_at::text, end_at::text
       FROM instinct_calendar_events_written
      WHERE user_id = $1
        AND action IN ('created', 'updated')
        AND start_at IS NOT NULL
        AND end_at IS NOT NULL
        AND start_at::date = $2::date
      ORDER BY start_at ASC`,
    [userId, dayISO],
  );

  const events = result.rows
    .map((r) => ({ start: new Date(r.start_at), end: new Date(r.end_at) }))
    .filter((e) => !isNaN(e.start.getTime()) && !isNaN(e.end.getTime()));

  let backToBack = 0;
  for (let i = 1; i < events.length; i++) {
    const gapMin = (events[i].start.getTime() - events[i - 1].end.getTime()) / 60000;
    if (gapMin < 15) backToBack += 1;
  }
  const score = Math.min(100, backToBack * 10);

  return {
    user_id: userId,
    day: dayISO,
    event_count: events.length,
    back_to_back_count: backToBack,
    score,
  };
}

function normalizeDay(day: string): string {
  if (day === "today") return new Date().toISOString().slice(0, 10);
  if (day === "yesterday") {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  const d = new Date(day);
  return isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
}
