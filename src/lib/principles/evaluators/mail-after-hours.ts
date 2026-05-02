/**
 * Real evaluator for `mail.after_hours_send`.
 *
 * Reads each subject user's recently sent messages via Microsoft Graph
 * and emits one Observation per send that lands outside business
 * hours (configurable; default 9pm–7am local using the user's tz from
 * Graph's `mailboxSettings`).
 *
 * Defensive: per-user fetch is wrapped in try/catch — any single
 * user's broken token / revoked scope returns [] instead of throwing,
 * so the cron iteration stays healthy.
 */

import { getValidToken } from "@/lib/microsoft-graph";
import {
  localHourInTz as sharedLocalHourInTz,
  ORG_TZ,
  type EvaluationContext,
  type Observation,
} from "@/lib/principles/validators";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

const NIGHT_START_HOUR_DEFAULT = 21; // 9pm
const NIGHT_END_HOUR_DEFAULT = 7; // 7am

interface RawSentMessage {
  id?: string;
  sentDateTime?: string;
  subject?: string;
  webLink?: string;
}

interface MailboxSettings {
  timeZone?: string;
  workingHours?: {
    startTime?: string;
    endTime?: string;
    timeZone?: { name?: string };
  };
}

/**
 * Convert a UTC ISO timestamp to the local hour at the user's tz.
 * Re-exported from validators.ts so existing callers keep working.
 */
export const localHourInTz = sharedLocalHourInTz;

/** Return true when localHour falls in the night window
 *  (start..23, then 0..end). 21..7 is the default. */
export function isAfterHours(
  localHour: number,
  startHour = NIGHT_START_HOUR_DEFAULT,
  endHour = NIGHT_END_HOUR_DEFAULT,
): boolean {
  if (startHour === endHour) return false;
  if (startHour < endHour) {
    return localHour >= startHour && localHour < endHour;
  }
  return localHour >= startHour || localHour < endHour;
}

async function fetchMailboxTimeZone(
  userId: string,
  accessToken: string,
): Promise<string> {
  try {
    const res = await fetch(`${GRAPH_BASE}/me/mailboxSettings`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return ORG_TZ;
    const data = (await res.json().catch(() => ({}))) as MailboxSettings;
    /* Prefer Graph's explicit working-hours tz, then mailbox tz, then
       the org default (Dallas). Falling back to UTC was misclassifying
       Dallas-evening sends as in-window. */
    return (
      data.workingHours?.timeZone?.name ||
      data.timeZone ||
      ORG_TZ
    );
  } catch {
    return ORG_TZ;
  }
}

async function fetchSentSince(
  accessToken: string,
  windowStartISO: string,
): Promise<{ rows: RawSentMessage[]; status: number }> {
  /* `$filter sentDateTime ge ...` is the Graph idiom for "since X". */
  const filter = `sentDateTime ge ${windowStartISO}`;
  const select = "id,sentDateTime,subject,webLink";
  const path =
    `me/mailFolders/sentitems/messages` +
    `?$top=200` +
    `&$select=${encodeURIComponent(select)}` +
    `&$filter=${encodeURIComponent(filter)}` +
    `&$orderby=sentDateTime desc`;
  const res = await fetch(`${GRAPH_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return { rows: [], status: res.status };
  const data = (await res.json().catch(() => ({}))) as {
    value?: RawSentMessage[];
  };
  return { rows: Array.isArray(data.value) ? data.value : [], status: 200 };
}

/**
 * Evaluator entry-point. Caller passes a context with subjectUserId
 * (the user whose mail we're scanning) + windowStart / windowEnd.
 * Returns one Observation per after-hours send. Score is -0.6 to keep
 * the signal "noticeable but not catastrophic" — the principle's
 * scoreboard_weight scales the impact in the team aggregate.
 */
export async function evaluateMailAfterHours(
  ctx: EvaluationContext,
): Promise<Observation[]> {
  const userId = ctx.subjectUserId;
  if (!userId) return [];
  const token = await getValidToken(userId);
  if (!token) return [];

  let tz: string;
  try {
    tz = await fetchMailboxTimeZone(userId, token.accessToken);
  } catch {
    tz = ORG_TZ;
  }

  let result: { rows: RawSentMessage[]; status: number };
  try {
    result = await fetchSentSince(token.accessToken, ctx.windowStart);
  } catch {
    return [];
  }
  if (result.status !== 200) return [];

  const observations: Observation[] = [];
  for (const m of result.rows) {
    if (!m.sentDateTime) continue;
    const hour = localHourInTz(m.sentDateTime, tz);
    if (!isAfterHours(hour)) continue;
    observations.push({
      surface: "mail",
      surfaceSubtype: "outlook_send_after_hours",
      subjectUserId: userId,
      observedAt: m.sentDateTime,
      /* counter-signal hits score negative — drift from the principle
         (off-hours respect). The framework's scoreboard inverts this
         for principles that frame the same observation positively. */
      score: -0.6,
      evidence: {
        kind: "outlook_send_after_hours",
        sourceId: m.id,
        sourceUrl: m.webLink,
        metric: { name: "send_hour_local", value: hour },
        notes: m.subject?.slice(0, 200),
      },
    });
  }
  return observations;
}
