/**
 * Real evaluator for `calendar.meeting_density`.
 *
 * Backs principle 8 (Async Default) — "most decisions don't need a
 * meeting" — and principle 11 (Calendar Hygiene). Counts the user's
 * busy events that fall inside business hours during the eval window
 * and scores how meeting-saturated the week was.
 *
 * Score tiers (per business week, scaled to whatever window the cron
 * passes):
 *   ≤ 10 meetings → +0.4 (lean)
 *   11–15         →  0.0 (neutral)
 *   16–20         → -0.3 (heavy)
 *   ≥ 21          → -0.6 (saturated)
 *
 * One observation per user per evaluation, observed_at snapped to UTC
 * midnight of the window-end day for migration-122 dedupe.
 */

import { getValidToken } from "@/lib/microsoft-graph";
import {
  localHourInTz,
  snapToUtcDay,
  ORG_TZ,
  type EvaluationContext,
  type Observation,
} from "@/lib/principles/validators";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/* Wolfpack is HQ'd in Dallas — business hours evaluated at America/Chicago
   (CST/CDT). Vercel runtime is UTC; reading getUTCHours misclassified a
   Dallas-9am meeting (UTC 14/15) as an after-hours block and a Dallas-
   evening meeting as in-window. */
const BUSINESS_START_HOUR = 9;
const BUSINESS_END_HOUR = 18;

interface RawEvent {
  id?: string;
  subject?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  isCancelled?: boolean;
  showAs?: string;
}

async function fetchEvents(
  accessToken: string,
  startISO: string,
  endISO: string,
): Promise<{ rows: RawEvent[]; status: number }> {
  const select = "id,subject,start,end,isCancelled,showAs";
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
  const data = (await res.json().catch(() => ({}))) as { value?: RawEvent[] };
  return { rows: Array.isArray(data.value) ? data.value : [], status: 200 };
}

/** Count business-hours busy events. Pure for unit testing. The hour
 *  comparison is done at ORG_TZ (Dallas) — server-local UTC was
 *  classifying real Dallas-9am meetings as off-hours. */
export function countBusinessMeetings(
  events: RawEvent[],
  tz: string = ORG_TZ,
): number {
  let n = 0;
  for (const ev of events) {
    if (ev.isCancelled) continue;
    if (ev.showAs && ev.showAs !== "busy") continue;
    const startISO = ev.start?.dateTime;
    if (!startISO) continue;
    const hour = localHourInTz(startISO, tz);
    if (hour < BUSINESS_START_HOUR || hour >= BUSINESS_END_HOUR) continue;
    n++;
  }
  return n;
}

/** Score a meeting count against the lean→saturated tiers. Pure. */
export function scoreForMeetingCount(count: number): {
  score: number;
  tier: "lean" | "neutral" | "heavy" | "saturated";
} {
  if (count <= 10) return { score: 0.4, tier: "lean" };
  if (count <= 15) return { score: 0, tier: "neutral" };
  if (count <= 20) return { score: -0.3, tier: "heavy" };
  return { score: -0.6, tier: "saturated" };
}

export async function evaluateCalendarMeetingDensity(
  ctx: EvaluationContext,
): Promise<Observation[]> {
  const userId = ctx.subjectUserId;
  if (!userId) return [];
  const token = await getValidToken(userId);
  if (!token) return [];

  let result: { rows: RawEvent[]; status: number };
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

  const count = countBusinessMeetings(result.rows);
  const { score, tier } = scoreForMeetingCount(count);

  return [
    {
      surface: "calendar",
      surfaceSubtype: "meeting_density",
      subjectUserId: userId,
      observedAt: snapToUtcDay(ctx.windowEnd),
      score,
      evidence: {
        kind: "meeting_density_rollup",
        metric: { name: "business_meetings", value: count },
        notes: `${count} business-hours meeting${count === 1 ? "" : "s"} in window (${tier})`,
      },
    },
  ];
}
