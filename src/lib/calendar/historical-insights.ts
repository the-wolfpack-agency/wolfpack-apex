/**
 * Historical calendar insights — windowed aggregations over a range
 * (week/month/year). Pure functions: callers pass the events, we
 * return trend metrics the /calendar page can visualise + feed to
 * the suggestions engine.
 *
 * All functions are side-effect-free so unit tests never need network
 * mocks, and the same computations can run offline over cached data.
 */

import type { CalendarEvent } from "@/lib/microsoft-graph";

export type RangeView = "week" | "month" | "year";

export interface HistoricalInsights {
  /** Total scheduled meeting hours inside the range. */
  totalMeetingHours: number;
  /** Count of meetings inside the range. */
  meetingCount: number;
  /** Meetings with zero attendees (likely focus blocks / holds). */
  soloBlockCount: number;
  /** Average meeting duration, minutes. null when no meetings. */
  averageDurationMinutes: number | null;
  /** Percentage of meetings that are back-to-back (within 5 min of the prior meeting's end). */
  backToBackPct: number;
  /** Top 5 recurring attendees across the range, name → count. */
  topAttendees: Array<{ display: string; count: number }>;
  /** Weekly meeting-hour time series, sorted oldest→newest. */
  weeklySeries: Array<{ weekStartIso: string; hours: number; count: number }>;
  /** Distribution of meetings by day-of-week (0=Sun .. 6=Sat). */
  dayOfWeekDistribution: number[];
}

const MS_MIN = 60_000;
const MS_HOUR = 60 * MS_MIN;
const MS_DAY = 24 * MS_HOUR;
const MS_WEEK = 7 * MS_DAY;

function parseMs(iso: string): number | null {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Returns the ISO string for the Sunday at 00:00 UTC of the week containing `ms`. */
function weekStart(ms: number): string {
  const d = new Date(ms);
  const dayOfWeek = d.getUTCDay();
  const floored = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() - dayOfWeek,
  );
  return new Date(floored).toISOString();
}

export interface ComputeHistoricalInput {
  events: CalendarEvent[];
  rangeStartMs: number;
  rangeEndMs: number;
}

export function computeHistoricalInsights(
  input: ComputeHistoricalInput,
): HistoricalInsights {
  const inRange = input.events
    .map((e) => {
      const s = parseMs(e.start);
      const en = parseMs(e.end);
      if (s === null || en === null) return null;
      if (en < input.rangeStartMs || s > input.rangeEndMs) return null;
      return { ev: e, s, en };
    })
    .filter((x): x is { ev: CalendarEvent; s: number; en: number } => x !== null)
    .sort((a, b) => a.s - b.s);

  let totalMs = 0;
  let solo = 0;
  const attendeeCounts = new Map<string, { display: string; count: number }>();
  const weeklyMap = new Map<string, { hours: number; count: number }>();
  const dow = [0, 0, 0, 0, 0, 0, 0];
  let backToBack = 0;
  let prevEnd: number | null = null;

  for (const { ev, s, en } of inRange) {
    const dur = Math.max(0, en - s);
    totalMs += dur;
    if ((ev.attendees?.length ?? 0) === 0) solo += 1;

    for (const a of ev.attendees ?? []) {
      if (typeof a !== "string") continue;
      const trimmed = a.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      const existing = attendeeCounts.get(key);
      if (existing) existing.count += 1;
      else attendeeCounts.set(key, { display: trimmed, count: 1 });
    }

    const wk = weekStart(s);
    const bucket = weeklyMap.get(wk) ?? { hours: 0, count: 0 };
    bucket.hours += dur / MS_HOUR;
    bucket.count += 1;
    weeklyMap.set(wk, bucket);

    dow[new Date(s).getUTCDay()] += 1;

    if (prevEnd !== null && s - prevEnd <= 5 * MS_MIN && s - prevEnd >= 0) {
      backToBack += 1;
    }
    prevEnd = en;
  }

  const topAttendees = [...attendeeCounts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const weeklySeries = [...weeklyMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([weekStartIso, b]) => ({
      weekStartIso,
      hours: round2(b.hours),
      count: b.count,
    }));

  const averageDurationMinutes =
    inRange.length === 0
      ? null
      : Math.round(totalMs / inRange.length / MS_MIN);

  const backToBackPct =
    inRange.length <= 1 ? 0 : Math.round((backToBack / inRange.length) * 100);

  return {
    totalMeetingHours: round2(totalMs / MS_HOUR),
    meetingCount: inRange.length,
    soloBlockCount: solo,
    averageDurationMinutes,
    backToBackPct,
    topAttendees,
    weeklySeries,
    dayOfWeekDistribution: dow,
  };
}

/** Helper: compute the UTC range bounds for a view + reference date. */
export function rangeBoundsFor(
  view: RangeView,
  referenceMs: number,
): { startMs: number; endMs: number } {
  const d = new Date(referenceMs);
  if (view === "week") {
    const dow = d.getUTCDay();
    const startMs = Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate() - dow,
    );
    return { startMs, endMs: startMs + MS_WEEK - 1 };
  }
  if (view === "month") {
    const startMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const endMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - 1;
    return { startMs, endMs };
  }
  const startMs = Date.UTC(d.getUTCFullYear(), 0, 1);
  const endMs = Date.UTC(d.getUTCFullYear() + 1, 0, 1) - 1;
  return { startMs, endMs };
}
