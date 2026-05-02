/**
 * Real evaluator for `calendar.meeting_agenda_present`.
 *
 * Sibling of `calendar.meeting_outcome_logged` but for events that
 * haven't started yet — checks whether each upcoming meeting has an
 * agenda in its body. The "no agenda → no meeting" half of principle
 * 8 (Async Default).
 *
 * Score: +0.3 when an upcoming event's body has agenda markers;
 * -0.3 otherwise. Skips:
 *   - cancelled events
 *   - free / OOO blocks
 *   - 1-minute placeholders (< 5 min duration)
 *   - past events (the outcome-logged validator already covers those)
 */

import { getValidToken } from "@/lib/microsoft-graph";
import { extractMeaningfulBody } from "@/lib/principles/evaluators/calendar-meeting-outcome-logged";
import type {
  EvaluationContext,
  Observation,
} from "@/lib/principles/validators";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

const AGENDA_PATTERNS: RegExp[] = [
  /\bagenda\b/i,
  /\btopics?\b/i,
  /\boutline\b/i,
  /\bgoals?\b/i,
  /\bgoal of (this|the) (call|meeting)\b/i,
  /\bpurpose\b/i,
  /^\s*1[\.)] /m,
  /^\s*[-*•] /m,
];

export function hasAgendaMarkers(meaningfulBody: string): boolean {
  if (meaningfulBody.length < 15) return false;
  return AGENDA_PATTERNS.some((re) => re.test(meaningfulBody));
}

interface RawEvent {
  id?: string;
  subject?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  isCancelled?: boolean;
  showAs?: string;
  webLink?: string;
  body?: { contentType?: string; content?: string };
}

async function fetchEvents(
  accessToken: string,
  startISO: string,
  endISO: string,
): Promise<{ rows: RawEvent[]; status: number }> {
  const select = "id,subject,start,end,isCancelled,showAs,webLink,body";
  const path =
    `me/calendarview` +
    `?startDateTime=${encodeURIComponent(startISO)}` +
    `&endDateTime=${encodeURIComponent(endISO)}` +
    `&$select=${encodeURIComponent(select)}` +
    `&$top=200`;
  const res = await fetch(`${GRAPH_BASE}/${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Prefer: 'outlook.body-content-type="text"',
    },
  });
  if (!res.ok) return { rows: [], status: res.status };
  const data = (await res.json().catch(() => ({}))) as { value?: RawEvent[] };
  return { rows: Array.isArray(data.value) ? data.value : [], status: 200 };
}

export async function evaluateCalendarMeetingAgendaPresent(
  ctx: EvaluationContext,
): Promise<Observation[]> {
  const userId = ctx.subjectUserId;
  if (!userId) return [];
  const token = await getValidToken(userId);
  if (!token) return [];

  /* Look at NOW → windowEnd (or a +14d window starting now if window
     is fully in the past). The cron's default 7d window is rear-
     facing; we extend forward to catch upcoming meetings. */
  const nowISO = new Date().toISOString();
  const upcomingEndMs = Math.max(
    Date.parse(ctx.windowEnd),
    Date.now() + 14 * 24 * 60 * 60 * 1000,
  );
  const upcomingEndISO = new Date(upcomingEndMs).toISOString();

  let result: { rows: RawEvent[]; status: number };
  try {
    result = await fetchEvents(token.accessToken, nowISO, upcomingEndISO);
  } catch {
    return [];
  }
  if (result.status !== 200) return [];

  const nowMs = Date.now();
  const observations: Observation[] = [];
  for (const ev of result.rows) {
    if (ev.isCancelled) continue;
    if (ev.showAs && ev.showAs !== "busy") continue;
    const startISO = ev.start?.dateTime;
    const endISO = ev.end?.dateTime;
    if (!startISO || !endISO) continue;
    const startMs = Date.parse(startISO);
    const endMs = Date.parse(endISO);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    /* Skip past events — meeting_outcome_logged handles those. */
    if (startMs < nowMs) continue;
    const minutes = (endMs - startMs) / (60 * 1000);
    if (minutes < 5) continue;

    const meaningful = extractMeaningfulBody(ev.body?.content);
    const hasAgenda = hasAgendaMarkers(meaningful);
    observations.push({
      surface: "calendar",
      surfaceSubtype: "meeting_agenda_present",
      subjectUserId: userId,
      observedAt: startISO,
      score: hasAgenda ? 0.3 : -0.3,
      evidence: {
        kind: "meeting_agenda_present",
        sourceId: ev.id,
        sourceUrl: ev.webLink,
        metric: { name: "meaningful_body_chars", value: meaningful.length },
        notes: ev.subject?.slice(0, 200),
      },
    });
  }
  return observations;
}
