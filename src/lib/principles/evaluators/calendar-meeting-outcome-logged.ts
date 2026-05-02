/**
 * Real evaluator for `calendar.meeting_outcome_logged`.
 *
 * Wolfpack principle 7 (Finish Strong) on calendar: "meetings closed
 * out with documented decisions and next steps". This evaluator walks
 * past meetings in the eval window and inspects each event's body for
 * structured-outcome content — markers for decisions, action items, or
 * next steps. Pure-text heuristic, zero LLM tokens.
 *
 * Scope:
 *   - Only past events (end < now) in the window — we can't judge a
 *     meeting that hasn't happened yet.
 *   - showAs == 'busy' (skip free-time / OOO blocks).
 *   - Skip events the user organized as a 1-minute placeholder
 *     (duration < 5min) — those are usually time-blocking, not real
 *     meetings worth a decision log.
 *
 * Score: +0.3 when the body shows decision/action/next-step markers,
 * -0.3 when the body is empty or pure invite boilerplate. The
 * principle's scoreboard_weight scales the impact in the team aggregate.
 */

import { getValidToken } from "@/lib/microsoft-graph";
import type {
  EvaluationContext,
  Observation,
} from "@/lib/principles/validators";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

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

const OUTCOME_PATTERNS: RegExp[] = [
  /\bdecision[s]?\b/i,
  /\baction items?\b/i,
  /\bnext steps?\b/i,
  /\bfollow[- ]?ups?\b/i,
  /\bowner[s]?\b/i,
  /\boutcome[s]?\b/i,
  /\bdue\b/i,
  /\bagreed\b/i,
];

/** Strip HTML and Outlook invite boilerplate so we can decide if there
 *  is any real outcome content. Pure for unit testing. */
export function extractMeaningfulBody(content: string | undefined): string {
  if (!content) return "";
  /* HTML → text. Defensive: don't pull in a parser, just regex strip. */
  const text = content
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  /* Strip Teams join boilerplate so a meeting whose body is only the
     join URL doesn't look like it has notes. */
  const stripped = text
    .replace(/Microsoft Teams[\s\S]*?Need help\?/gi, " ")
    .replace(/_{5,}/g, " ")
    .replace(/Join the meeting now[\s\S]*$/i, " ")
    .replace(/Meeting ID:.*$/im, " ")
    .replace(/Passcode:.*$/im, " ")
    .replace(/https?:\/\/\S+/g, " ");
  return stripped.replace(/\s+/g, " ").trim();
}

/** Decide if a meaningful body has decision/action/next-step markers.
 *  Pure for unit testing. */
export function hasOutcomeMarkers(meaningfulBody: string): boolean {
  if (meaningfulBody.length < 10) return false;
  return OUTCOME_PATTERNS.some((re) => re.test(meaningfulBody));
}

async function fetchPastEvents(
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

export async function evaluateCalendarMeetingOutcomeLogged(
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
  const observations: Observation[] = [];
  for (const ev of result.rows) {
    if (ev.isCancelled) continue;
    if (ev.showAs && ev.showAs !== "busy") continue;
    const startISO = ev.start?.dateTime;
    const endISO = ev.end?.dateTime;
    if (!endISO) continue;
    const endMs = Date.parse(endISO);
    if (!Number.isFinite(endMs) || endMs > nowMs) continue;
    const startMs = startISO ? Date.parse(startISO) : NaN;
    if (Number.isFinite(startMs)) {
      const minutes = (endMs - startMs) / (60 * 1000);
      if (minutes < 5) continue;
    }
    const meaningful = extractMeaningfulBody(ev.body?.content);
    const logged = hasOutcomeMarkers(meaningful);
    observations.push({
      surface: "calendar",
      surfaceSubtype: "meeting_outcome_logged",
      subjectUserId: userId,
      observedAt: endISO,
      score: logged ? 0.3 : -0.3,
      evidence: {
        kind: "meeting_outcome_logged",
        sourceId: ev.id,
        sourceUrl: ev.webLink,
        metric: { name: "meaningful_body_chars", value: meaningful.length },
        notes: ev.subject?.slice(0, 200),
      },
    });
  }
  return observations;
}
