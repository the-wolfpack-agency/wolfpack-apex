/**
 * Real evaluator for `calendar.focus_block_ratio`.
 *
 * Reads the user's calendar over the evaluation window, identifies
 * "focus blocks" — uninterrupted ≥2h gaps during business hours
 * (9am–5pm local) — and emits one Observation per business-day. The
 * score is positive (adherence) when the focus-block ratio is ≥0.4
 * for that day, negative (drift) otherwise. The principle's prose
 * is what frames "is this good or bad" for the human reader; the
 * data is the same either way.
 *
 * Defensive: per-user fetch is wrapped — token revocation, calendar
 * scope missing, or a 5xx returns [] instead of throwing.
 */

import { getValidToken } from "@/lib/microsoft-graph";
import type {
  EvaluationContext,
  Observation,
} from "@/lib/principles/validators";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

interface CalEvent {
  id?: string;
  subject?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  isCancelled?: boolean;
  showAs?: string; // 'busy' | 'free' | 'tentative' | ...
  webLink?: string;
}

const BUSINESS_START_HOUR = 9;
const BUSINESS_END_HOUR = 17;
const FOCUS_BLOCK_MIN_HOURS = 2;
const ADHERENCE_RATIO = 0.4;

function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}

/** Pull events in the window via /me/calendarview. */
async function fetchEvents(
  accessToken: string,
  startISO: string,
  endISO: string,
): Promise<{ rows: CalEvent[]; status: number }> {
  const select = "id,subject,start,end,isCancelled,showAs,webLink";
  const path =
    `me/calendarview` +
    `?startDateTime=${encodeURIComponent(startISO)}` +
    `&endDateTime=${encodeURIComponent(endISO)}` +
    `&$select=${encodeURIComponent(select)}` +
    `&$top=500`;
  const res = await fetch(`${GRAPH_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return { rows: [], status: res.status };
  const data = (await res.json().catch(() => ({}))) as {
    value?: CalEvent[];
  };
  return { rows: Array.isArray(data.value) ? data.value : [], status: 200 };
}

/**
 * Compute total focus-hours within business hours for a single date.
 * Algorithm: build a 9–17 window, subtract every busy-event interval
 * (capped at the window), then merge contiguous gaps and sum gaps
 * ≥ FOCUS_BLOCK_MIN_HOURS.
 *
 * Pure function, exported for unit testing.
 */
export function computeFocusHoursForDate(
  date: Date,
  events: Array<{ startMs: number; endMs: number }>,
): { focusHours: number; ratio: number } {
  const dayStart = new Date(date);
  dayStart.setHours(BUSINESS_START_HOUR, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setHours(BUSINESS_END_HOUR, 0, 0, 0);
  const dayStartMs = dayStart.getTime();
  const dayEndMs = dayEnd.getTime();
  const totalWindowHours = (dayEndMs - dayStartMs) / (60 * 60 * 1000);

  /* Sort + clip events to the business window. */
  const clipped = events
    .map((e) => ({
      startMs: Math.max(e.startMs, dayStartMs),
      endMs: Math.min(e.endMs, dayEndMs),
    }))
    .filter((e) => e.endMs > e.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  /* Walk gaps between merged events. */
  let cursor = dayStartMs;
  let focusMs = 0;
  for (const e of clipped) {
    if (e.startMs > cursor) {
      const gapHours = (e.startMs - cursor) / (60 * 60 * 1000);
      if (gapHours >= FOCUS_BLOCK_MIN_HOURS) {
        focusMs += e.startMs - cursor;
      }
    }
    cursor = Math.max(cursor, e.endMs);
  }
  if (cursor < dayEndMs) {
    const gapHours = (dayEndMs - cursor) / (60 * 60 * 1000);
    if (gapHours >= FOCUS_BLOCK_MIN_HOURS) {
      focusMs += dayEndMs - cursor;
    }
  }
  const focusHours = focusMs / (60 * 60 * 1000);
  return {
    focusHours,
    ratio: totalWindowHours > 0 ? focusHours / totalWindowHours : 0,
  };
}

/** Group raw events by local date (YYYY-MM-DD), filter cancelled +
 *  free-time + multi-day all-day events. */
export function bucketEventsByDate(
  events: CalEvent[],
): Map<string, Array<{ startMs: number; endMs: number }>> {
  const out = new Map<string, Array<{ startMs: number; endMs: number }>>();
  for (const e of events) {
    if (e.isCancelled) continue;
    if (e.showAs && e.showAs !== "busy" && e.showAs !== "tentative") continue;
    const startISO = e.start?.dateTime;
    const endISO = e.end?.dateTime;
    if (!startISO || !endISO) continue;
    const startMs = new Date(startISO).getTime();
    const endMs = new Date(endISO).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    /* Bucket by the day the event STARTS. Multi-day events are clipped
       to the day's window inside computeFocusHoursForDate. */
    const dateKey = fmtDate(startISO);
    const list = out.get(dateKey) ?? [];
    list.push({ startMs, endMs });
    out.set(dateKey, list);
  }
  return out;
}

export async function evaluateCalendarFocusBlock(
  ctx: EvaluationContext,
): Promise<Observation[]> {
  const userId = ctx.subjectUserId;
  if (!userId) return [];
  const token = await getValidToken(userId);
  if (!token) return [];
  let result;
  try {
    result = await fetchEvents(
      token.accessToken,
      ctx.windowStart,
      ctx.windowEnd,
    );
  } catch {
    return [];
  }
  if (result.status !== 200) return [];

  const buckets = bucketEventsByDate(result.rows);
  const observations: Observation[] = [];

  /* Iterate every business day in the window — including days with
     no events. A day with no meetings is a maximum-focus day; it
     still gets an observation so the scoreboard sees the win. */
  const start = new Date(ctx.windowStart);
  const end = new Date(ctx.windowEnd);
  const dayMs = 24 * 60 * 60 * 1000;
  for (let t = start.getTime(); t <= end.getTime(); t += dayMs) {
    const d = new Date(t);
    /* Skip weekends — focus-block expectations are business-day only. */
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    const key = fmtDate(d.toISOString());
    const events = buckets.get(key) ?? [];
    const { focusHours, ratio } = computeFocusHoursForDate(d, events);
    /* Score: +0.5 when ratio ≥ 0.4 (adherence), -0.5 below.
       Magnitude is moderate so a single soggy day doesn't tank the
       weekly mean. */
    const score = ratio >= ADHERENCE_RATIO ? 0.5 : -0.5;
    observations.push({
      surface: "calendar",
      surfaceSubtype: "focus_block_ratio",
      subjectUserId: userId,
      observedAt: d.toISOString(),
      score,
      evidence: {
        kind: "calendar_focus_day",
        metric: { name: "focus_hours", value: Number(focusHours.toFixed(2)) },
        notes: `${events.length} event${events.length === 1 ? "" : "s"} during business hours`,
      },
    });
  }
  return observations;
}
