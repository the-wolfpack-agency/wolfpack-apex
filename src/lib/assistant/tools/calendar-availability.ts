/**
 * Token-free calendar availability tool.
 *
 * Given a person name + a timeframe token, resolves the person to a
 * userId via the MS directory sync + fetches their calendar events
 * for the window + returns a deterministic natural-language answer.
 *
 * Never calls the LLM. Returns null when we can't resolve the person
 * so the orchestrator can fall back to RAG.
 */

import { fetchCalendarEvents, type CalendarEvent } from "@/lib/microsoft-graph";
import { resolveTimeframe } from "@/lib/assistant/timeframe";
import { safeQuery } from "@/lib/db";

export interface CalendarAvailabilityResult {
  person: string;
  timeframeLabel: string;
  busy: boolean;
  events: Array<{ subject: string; start: string; end: string }>;
  answer: string;
}

/**
 * Resolve a person name (first, last, or "First Last") to the same
 * userId that MS Graph knows. Pulls from the canonical directory
 * sync table populated by src/lib/ms-graph/sync. Returns the Graph
 * user id (email in practice) or null.
 */
export async function resolvePersonToGraphUser(
  name: string,
): Promise<{ userId: string; displayName: string } | null> {
  const needle = name.trim().toLowerCase();
  if (!needle) return null;
  // Look up by display name match or email prefix/suffix in the
  // canonical MS user mirror (migration 077).
  const { rows } = await safeQuery<{
    user_id: string;
    display_name: string | null;
    mail: string | null;
  }>(
    `SELECT user_id, display_name, mail
     FROM instinct_ms_users
     WHERE LOWER(display_name) LIKE '%' || $1 || '%'
        OR LOWER(mail) LIKE $1 || '%@%'
        OR LOWER(mail) LIKE '%' || $1 || '%'
     LIMIT 1`,
    [needle],
  );
  if (rows.length === 0) return null;
  return {
    userId: rows[0].mail || rows[0].user_id,
    displayName: rows[0].display_name || rows[0].mail || rows[0].user_id,
  };
}

function formatTime(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  });
}

export async function runCalendarAvailability(params: {
  personName: string;
  timeframeToken: string | undefined;
  nowMs?: number;
  // When set, skip the directory resolve and treat this as the caller's
  // own calendar (first-person queries: "am I busy", "what's on my calendar").
  selfUser?: { userId: string; displayName: string };
  // IANA zone (e.g. "America/New_York"); when unset, server zone is used.
  timeZone?: string;
}): Promise<CalendarAvailabilityResult | null> {
  const resolved = params.selfUser
    ? params.selfUser
    : await resolvePersonToGraphUser(params.personName);
  if (!resolved) return null;
  const isSelf = Boolean(params.selfUser);
  const range = resolveTimeframe(params.timeframeToken, params.nowMs);

  let events: CalendarEvent[] = [];
  try {
    events = await fetchCalendarEvents(
      resolved.userId,
      new Date(range.startMs).toISOString(),
      new Date(range.endMs).toISOString(),
    );
  } catch {
    return null;
  }

  const overlapping = events.filter((e) => {
    const s = Date.parse(e.start);
    const en = Date.parse(e.end);
    if (Number.isNaN(s) || Number.isNaN(en)) return false;
    return en >= range.startMs && s <= range.endMs;
  });

  const busy = overlapping.length > 0;
  const summary = overlapping
    .slice(0, 3)
    .map((e) => `${e.subject} (${formatTime(e.start, params.timeZone)}–${formatTime(e.end, params.timeZone)})`)
    .join(", ");

  const subject = isSelf ? "You" : resolved.displayName;
  const haveVerb = isSelf ? "have" : "has";
  const freeVerb = isSelf ? "look" : "looks";
  const answer = busy
    ? `${subject} ${haveVerb} ${overlapping.length} meeting${overlapping.length === 1 ? "" : "s"} ${range.label}: ${summary}${overlapping.length > 3 ? ", …" : "."}`
    : `${subject} ${freeVerb} free ${range.label}.`;

  return {
    person: resolved.displayName,
    timeframeLabel: range.label,
    busy,
    events: overlapping.map((e) => ({ subject: e.subject, start: e.start, end: e.end })),
    answer,
  };
}
