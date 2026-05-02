/**
 * Real evaluator for `calendar.recurring_meeting_drift`.
 *
 * Wolfpack principle 7 (Finish Strong) — counter-signal: "recurring
 * meetings carrying the same agenda items into a third week". This
 * evaluator groups events in the eval window by their `seriesMasterId`
 * and flags series running >= 3 instances WITHOUT any recorded outcome
 * content (re-using the meeting-outcome-logged heuristic).
 *
 * Score: one observation per recurring series. Score is -0.4 when the
 * series is running stale (3+ instances, no outcome markers in any
 * instance's body). Score is +0.2 when the series has 3+ instances and
 * outcome markers in ≥ half of them ("recurring with discipline").
 * Series with < 3 instances in the window are skipped — not enough
 * data to call drift.
 */

import { getValidToken } from "@/lib/microsoft-graph";
import {
  extractMeaningfulBody,
  hasOutcomeMarkers,
} from "@/lib/principles/evaluators/calendar-meeting-outcome-logged";
import type {
  EvaluationContext,
  Observation,
} from "@/lib/principles/validators";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

interface RawEvent {
  id?: string;
  subject?: string;
  seriesMasterId?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  isCancelled?: boolean;
  showAs?: string;
  webLink?: string;
  body?: { contentType?: string; content?: string };
}

const MIN_INSTANCES_FOR_DRIFT = 3;

async function fetchEvents(
  accessToken: string,
  startISO: string,
  endISO: string,
): Promise<{ rows: RawEvent[]; status: number }> {
  const select =
    "id,subject,seriesMasterId,start,end,isCancelled,showAs,webLink,body";
  const path =
    `me/calendarview` +
    `?startDateTime=${encodeURIComponent(startISO)}` +
    `&endDateTime=${encodeURIComponent(endISO)}` +
    `&$select=${encodeURIComponent(select)}` +
    `&$top=500`;
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

interface SeriesRollup {
  seriesId: string;
  subject: string;
  instances: number;
  withOutcome: number;
  firstStart: string | null;
  lastWebLink: string | null;
}

/** Pure rollup so unit tests don't need a Graph response. */
export function buildSeriesRollups(events: RawEvent[]): SeriesRollup[] {
  const byId = new Map<string, SeriesRollup>();
  for (const ev of events) {
    if (ev.isCancelled) continue;
    if (ev.showAs && ev.showAs !== "busy") continue;
    const seriesId = ev.seriesMasterId;
    if (!seriesId) continue;
    const startISO = ev.start?.dateTime ?? null;
    const meaningful = extractMeaningfulBody(ev.body?.content);
    const logged = hasOutcomeMarkers(meaningful);
    const cur = byId.get(seriesId) ?? {
      seriesId,
      subject: ev.subject?.slice(0, 200) ?? "(no subject)",
      instances: 0,
      withOutcome: 0,
      firstStart: null,
      lastWebLink: null,
    };
    cur.instances += 1;
    if (logged) cur.withOutcome += 1;
    if (startISO && (!cur.firstStart || startISO < cur.firstStart)) {
      cur.firstStart = startISO;
    }
    if (ev.webLink) cur.lastWebLink = ev.webLink;
    byId.set(seriesId, cur);
  }
  return Array.from(byId.values());
}

/** Score a series by instance count + outcome ratio. Pure. */
export function scoreSeries(rollup: SeriesRollup): {
  score: number;
  tier: "drift" | "with_discipline" | "skipped";
} {
  if (rollup.instances < MIN_INSTANCES_FOR_DRIFT) {
    return { score: 0, tier: "skipped" };
  }
  const outcomeRatio = rollup.withOutcome / rollup.instances;
  if (outcomeRatio >= 0.5) {
    return { score: 0.2, tier: "with_discipline" };
  }
  return { score: -0.4, tier: "drift" };
}

export async function evaluateCalendarRecurringMeetingDrift(
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

  const rollups = buildSeriesRollups(result.rows);
  const observations: Observation[] = [];
  for (const r of rollups) {
    const { score, tier } = scoreSeries(r);
    if (tier === "skipped") continue;
    observations.push({
      surface: "calendar",
      surfaceSubtype: "recurring_meeting_drift",
      subjectUserId: userId,
      observedAt: r.firstStart ?? new Date().toISOString(),
      score,
      evidence: {
        kind: "recurring_meeting_drift",
        sourceId: r.seriesId,
        sourceUrl: r.lastWebLink ?? undefined,
        metric: { name: "instances", value: r.instances },
        notes: `${r.subject} — ${r.instances} instance${r.instances === 1 ? "" : "s"}, ${r.withOutcome} with outcome notes (${tier})`,
      },
    });
  }
  return observations;
}
