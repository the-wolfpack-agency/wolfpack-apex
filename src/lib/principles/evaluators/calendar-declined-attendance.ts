/**
 * Real evaluator for `calendar.declined_attendance_rate`.
 *
 * Backs principle 11 (Calendar Hygiene) — "your calendar reflects
 * reality". Looks at past events in the eval window where the user's
 * responseStatus is 'declined' or 'tentativelyAccepted' but the event
 * still appears on their calendar (not removed). High counts surface
 * the ghost-meeting / "yes by default" pattern that wrecks calendar
 * trust.
 *
 * One observation per user per evaluation, with a per-event sample
 * list embedded in evidence so the drill-down shows the worst rows.
 *
 * Score:
 *   declined-attended count == 0 → +0.3
 *   1–2                          →  0.0
 *   3–5                          → -0.3
 *   ≥ 6                          → -0.6
 */

import { getValidToken } from "@/lib/microsoft-graph";
import {
  snapToUtcDay,
  type EvaluationContext,
  type Observation,
} from "@/lib/principles/validators";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

interface RawEvent {
  id?: string;
  subject?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  isCancelled?: boolean;
  showAs?: string;
  responseStatus?: { response?: string };
  webLink?: string;
}

async function fetchPastEvents(
  accessToken: string,
  startISO: string,
  endISO: string,
): Promise<{ rows: RawEvent[]; status: number }> {
  const select = "id,subject,start,end,isCancelled,showAs,responseStatus,webLink";
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

export function scoreForDeclinedCount(count: number): number {
  if (count === 0) return 0.3;
  if (count <= 2) return 0;
  if (count <= 5) return -0.3;
  return -0.6;
}

export async function evaluateCalendarDeclinedAttendance(
  ctx: EvaluationContext,
): Promise<Observation[]> {
  const userId = ctx.subjectUserId;
  if (!userId) return [];
  const token = await getValidToken(userId);
  if (!token) return [];

  let result: { rows: RawEvent[]; status: number };
  try {
    result = await fetchPastEvents(
      token.accessToken,
      ctx.windowStart,
      ctx.windowEnd,
    );
  } catch {
    return [];
  }
  if (result.status !== 200) return [];

  const nowMs = Date.now();
  const ghostSubjects: string[] = [];
  for (const ev of result.rows) {
    if (ev.isCancelled) continue;
    if (ev.showAs && ev.showAs !== "busy" && ev.showAs !== "tentative") continue;
    const endISO = ev.end?.dateTime;
    if (!endISO) continue;
    const endMs = Date.parse(endISO);
    if (!Number.isFinite(endMs) || endMs > nowMs) continue;
    const r = ev.responseStatus?.response ?? "";
    /* "declined" but still on the calendar = ghost; "tentativelyAccepted"
       on a past event = also a ghost. Both are calendar-hygiene drift. */
    if (r === "declined" || r === "tentativelyAccepted") {
      if (ev.subject) ghostSubjects.push(ev.subject.slice(0, 80));
    }
  }

  const count = ghostSubjects.length;
  const score = scoreForDeclinedCount(count);
  const sample = ghostSubjects.slice(0, 3).join(" · ");
  const notes =
    count === 0
      ? "no ghost meetings in window — calendar reflects reality"
      : `${count} ghost meeting${count === 1 ? "" : "s"} (declined / tentative on past events): ${sample}${count > 3 ? " …" : ""}`;

  return [
    {
      surface: "calendar",
      surfaceSubtype: "declined_attendance_rate",
      subjectUserId: userId,
      observedAt: snapToUtcDay(ctx.windowEnd),
      score,
      evidence: {
        kind: "declined_attendance_rollup",
        metric: { name: "ghost_meetings", value: count },
        notes,
      },
    },
  ];
}
