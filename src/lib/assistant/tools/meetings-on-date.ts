/**
 * Zero-token meetings-on-date tool.
 *
 * Answers questions like:
 *   "which meetings did wolfpack have on April 21, 2026?"
 *   "what meetings did we have last Tuesday?"
 *   "meetings on 2026-04-21"
 *
 * Why this exists: the prior path fell through to the LLM every time
 * because no intent matched, and the knowledge cache is bypassed for
 * date-bound questions (see assistant.ts MEETING_OR_DATE_BYPASS_PATTERNS).
 * Asking the same question twice burned tokens twice. The meeting
 * transcript table already holds the authoritative answer keyed on
 * recorded_at, so we serve directly from Postgres — no embedding, no LLM.
 */
import { safeQuery } from "@/lib/db";
import { listEvents } from "@/lib/integrations/microsoft-calendar";
import { getRelevantContext } from "@/lib/assistant/context-resolver";
import { resolveIanaZone, zonedWallClockToUtcMs } from "@/lib/calendar/timezone";

export interface MeetingOnDateRow {
  id: string;
  title: string | null;
  summary: string | null;
  recordedAt: string | null;
  durationSeconds: number | null;
  ownerName: string | null;
}

export interface MeetingsOnDateResult {
  answer: string;
  meetings: MeetingOnDateRow[];
  dateLabel: string;
  startMs: number;
  endMs: number;
}


/**
 * Parse a free-text date out of the question. Returns the UTC day
 * bounds (start-of-day inclusive, end-of-day inclusive) when found.
 *
 * Recognized:
 *   - "April 21, 2026" / "april 21 2026" / "Apr 21 2026"
 *   - "2026-04-21" (ISO)
 *   - "4/21/2026" / "04/21/26" (US m/d/y)
 */
export function extractExplicitDate(
  text: string,
  nowMs = Date.now(),
  timeZone?: string,
): { startMs: number; endMs: number; label: string } | null {
  const q = text.trim();

  // ISO: 2026-04-21
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(q);
  if (iso) {
    const [, y, m, d] = iso;
    return dayBounds(Number(y), Number(m) - 1, Number(d), timeZone);
  }

  // US: 4/21/2026 or 04/21/26
  const us = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/.exec(q);
  if (us) {
    const [, m, d, yr] = us;
    let y = Number(yr);
    if (y < 100) y += 2000;
    return dayBounds(y, Number(m) - 1, Number(d), timeZone);
  }

  // Month name: "April 21, 2026" or "Apr 21 2026". Year optional —
  // defaults to the year of `nowMs` when omitted.
  const months: Record<string, number> = {
    jan: 0, january: 0,
    feb: 1, february: 1,
    mar: 2, march: 2,
    apr: 3, april: 3,
    may: 4,
    jun: 5, june: 5,
    jul: 6, july: 6,
    aug: 7, august: 7,
    sep: 8, sept: 8, september: 8,
    oct: 9, october: 9,
    nov: 10, november: 10,
    dec: 11, december: 11,
  };
  const named = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,\s*|\s+)?(\d{4})?\b/i.exec(
    q,
  );
  if (named) {
    const monthIdx = months[named[1].toLowerCase()];
    const day = Number(named[2]);
    const year = named[3]
      ? Number(named[3])
      : new Date(nowMs).getUTCFullYear();
    if (monthIdx != null && day >= 1 && day <= 31) {
      return dayBounds(year, monthIdx, day, timeZone);
    }
  }

  return null;
}

/**
 * The [start, end] instants of a calendar day, IN THE CALLER'S ZONE.
 *
 * This built the day with Date.UTC, so "the 25th" meant 00:00Z to 23:59Z on
 * the 25th. For anybody west of Greenwich that is not their 25th: an 8pm
 * Eastern meeting on the 25th happens at 00:00Z on the 26th and was reported
 * under the wrong date, while a meeting from the evening of the 24th was
 * counted as theirs. Evening meetings are exactly the ones people ask about
 * after the fact.
 *
 * Sibling of the display bug fixed in #389 - same cause, a server in UTC
 * deciding what a local day is - and it uses the same canonical zone helpers
 * rather than a second implementation of the arithmetic.
 *
 * The end is the next local midnight less a millisecond rather than start plus
 * 24 hours, because a DST day is 23 or 25 hours long and the fixed offset
 * would clip or overrun it.
 */
function dayBounds(
  y: number,
  monthIdx: number,
  day: number,
  timeZone?: string,
): { startMs: number; endMs: number; label: string } {
  const iana = resolveIanaZone(timeZone) ?? "UTC";
  const startMs =
    iana === "UTC"
      ? Date.UTC(y, monthIdx, day)
      : zonedWallClockToUtcMs(y, monthIdx + 1, day, 0, 0, 0, iana);
  /* Date.UTC normalises day+1 over month and year ends. */
  const nextUtc = new Date(Date.UTC(y, monthIdx, day + 1));
  const nextMs =
    iana === "UTC"
      ? nextUtc.getTime()
      : zonedWallClockToUtcMs(
          nextUtc.getUTCFullYear(),
          nextUtc.getUTCMonth() + 1,
          nextUtc.getUTCDate(),
          0,
          0,
          0,
          iana,
        );
  const endMs = nextMs - 1;
  const label = new Date(startMs).toLocaleDateString("en-US", {
    timeZone: iana,
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return { startMs, endMs, label };
}

export async function runMeetingsOnDate(args: {
  question: string;
  nowMs?: number;
  /** Calling user's id — used to read their MS 365 calendar via Graph
   *  delegated token. Optional: when absent, we still hit our cached
   *  tables but skip live calendar. */
  userId?: string;
  /** Caller's IANA zone. Decides which calendar day "the 25th" is, and which
   *  clock the times below are read in. Absent falls back to UTC. */
  timeZone?: string;
}): Promise<MeetingsOnDateResult | null> {
  const range = extractExplicitDate(args.question, args.nowMs ?? Date.now(), args.timeZone);
  if (!range) return null;
  if (!process.env.DATABASE_URL) return null;

  /* Pull from BOTH meeting sources we ingest:
       - instinct_meeting_transcripts: Plaud-recorded transcripts (audio).
       - instinct_online_meetings:     Microsoft Teams meetings (calendar).
     A meeting can exist in either, both, or neither. We UNION and dedupe
     by ms_meeting_id when present so a Teams meeting that also has a
     Plaud transcript counts once. */
  const calendarPromise = args.userId
    ? listEvents(args.userId, {
        from: new Date(range.startMs).toISOString(),
        to: new Date(range.endMs).toISOString(),
        limit: 50,
      }).catch(() => [])
    : Promise.resolve([] as Awaited<ReturnType<typeof listEvents>>);

  const [transcriptsRes, onlineRes, calendarEvents] = await Promise.all([
    safeQuery<{
      id: string;
      title: string | null;
      summary: string | null;
      recorded_at: string | null;
      duration_seconds: number | null;
      owner_name: string | null;
    }>(
      `SELECT t.id, t.title, t.summary, t.recorded_at, t.duration_seconds,
              m.name AS owner_name
         FROM instinct_meeting_transcripts t
         LEFT JOIN instinct_team_members m ON m.id = t.owner_user_id
        WHERE t.quality_status <> 'reject'
          AND t.recorded_at IS NOT NULL
          AND t.recorded_at >= to_timestamp($1 / 1000.0)
          AND t.recorded_at <= to_timestamp($2 / 1000.0)
        ORDER BY t.recorded_at ASC
        LIMIT 50`,
      [range.startMs, range.endMs],
    ),
    safeQuery<{
      id: string;
      ms_meeting_id: string | null;
      subject: string | null;
      start_at: string | null;
      end_at: string | null;
      owner_name: string | null;
    }>(
      `SELECT DISTINCT ON (COALESCE(om.ms_meeting_id, om.id::text))
              om.id, om.ms_meeting_id, om.subject, om.start_at, om.end_at,
              m.name AS owner_name
         FROM instinct_online_meetings om
         LEFT JOIN instinct_team_members m ON m.id = om.user_id
        WHERE om.start_at IS NOT NULL
          AND om.start_at >= to_timestamp($1 / 1000.0)
          AND om.start_at <= to_timestamp($2 / 1000.0)
        ORDER BY COALESCE(om.ms_meeting_id, om.id::text), om.start_at ASC
        LIMIT 50`,
      [range.startMs, range.endMs],
    ),
    calendarPromise,
  ]);

  const merged: MeetingOnDateRow[] = [
    ...transcriptsRes.rows.map((r) => ({
      id: r.id,
      title: r.title,
      summary: r.summary,
      recordedAt: r.recorded_at,
      durationSeconds: r.duration_seconds,
      ownerName: r.owner_name,
    })),
    ...onlineRes.rows.map((r) => ({
      id: r.id,
      title: r.subject,
      summary: null,
      recordedAt: r.start_at,
      durationSeconds:
        r.start_at && r.end_at
          ? Math.round(
              (new Date(r.end_at).getTime() -
                new Date(r.start_at).getTime()) /
                1000,
            )
          : null,
      ownerName: r.owner_name,
    })),
    ...calendarEvents.map((ev) => ({
      id: ev.id,
      title: ev.subject,
      summary: ev.attendees.length
        ? `Participants: ${ev.attendees.slice(0, 8).join(", ")}`
        : null,
      recordedAt: ev.start,
      durationSeconds:
        ev.start && ev.end
          ? Math.round(
              (new Date(ev.end).getTime() - new Date(ev.start).getTime()) /
                1000,
            )
          : null,
      ownerName: null,
    })),
  ];

  /* Dedupe across the three sources by (normalized title + start
     timestamp). MS Teams meetings often appear in BOTH instinct_online_meetings
     AND the user's live /me/calendarview, and the same meeting can also
     have a Plaud transcript. Without this, the answer would list a
     single meeting three times. */
  const seen = new Set<string>();
  const meetings: MeetingOnDateRow[] = [];
  for (const m of merged) {
    const key = `${(m.title ?? "").toLowerCase().trim()}|${m.recordedAt ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    meetings.push(m);
  }
  meetings.sort((a, b) => {
    const ta = a.recordedAt ? new Date(a.recordedAt).getTime() : 0;
    const tb = b.recordedAt ? new Date(b.recordedAt).getTime() : 0;
    return ta - tb;
  });

  /* Empty result: return a precise, source-aware answer from the tool
     itself rather than falling through to the LLM. The LLM has no way
     to know the system DID query MS Teams + the user's Outlook calendar
     — when the grounding block is empty it hallucinates "we don't store
     meeting records", which is wrong. Listing the surfaces we ACTUALLY
     queried turns the empty result into actionable information.

     We probe integration status rather than blindly listing every
     surface — Plaud isn't always wired, and naming a surface that
     wasn't actually queried would be its own form of misleading. */
  if (meetings.length === 0) {
    const surfaces: string[] = [];

    /* Plaud: integrated if instinct_meeting_transcripts has ANY row.
       Cheap one-row probe; the table is tiny in practice. */
    try {
      const probe = await safeQuery<{ exists: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM instinct_meeting_transcripts LIMIT 1) AS exists`,
        [],
      );
      if (probe.rows[0]?.exists) surfaces.push("Plaud transcripts");
    } catch {
      /* table missing or query failed — treat as not integrated */
    }

    /* MS Teams: integrated if instinct_online_meetings has ANY row. */
    try {
      const probe = await safeQuery<{ exists: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM instinct_online_meetings LIMIT 1) AS exists`,
        [],
      );
      if (probe.rows[0]?.exists) surfaces.push("Microsoft Teams meetings");
    } catch {
      /* table missing — treat as not integrated */
    }

    /* Outlook calendar: integrated if we actually got a Graph response
       for the caller. We can't distinguish "no events on this date" from
       "no Graph token" cleanly post-hoc, so we only claim Outlook when
       the user explicitly passed userId AND has any cached MS token row.
       Worst case: we under-claim and the user sees a shorter list. */
    if (args.userId) {
      try {
        const probe = await safeQuery<{ exists: boolean }>(
          `SELECT EXISTS(
             SELECT 1 FROM instinct_microsoft_tokens
             WHERE user_id = $1 LIMIT 1
           ) AS exists`,
          [args.userId],
        );
        if (probe.rows[0]?.exists) surfaces.push("your Outlook calendar");
      } catch {
        /* table missing — treat as not integrated */
      }
    }

    const surfacesText =
      surfaces.length > 0
        ? `across ${surfaces.join(", ")}`
        : "in any connected source";
    const settingsHint =
      surfaces.length === 0
        ? `No meeting integrations are connected yet. Connect Microsoft 365 in [Settings](/settings) to surface calendar + Teams meetings here.`
        : `If meetings happened that day, confirm your integrations are connected in [Settings](/settings).`;
    const answer =
      `No meetings found on ${range.label} ${surfacesText}.\n\n` +
      `${settingsHint}\n\n` +
      `Go to: [Meetings](/meetings)`;
    return {
      answer,
      meetings,
      dateLabel: range.label,
      startMs: range.startMs,
      endMs: range.endMs,
    };
  }

  /* Named once so the times and the day they are grouped under can never
     disagree about which zone they are in. */
  const zone = resolveIanaZone(args.timeZone) ?? "UTC";
  const lines = meetings.map((m) => {
    const time = m.recordedAt
      ? new Date(m.recordedAt).toLocaleTimeString("en-US", {
          timeZone: zone,
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        })
      : "time unknown";
    const title = m.title ?? "Untitled meeting";
    const owner = m.ownerName ? ` — ${m.ownerName}` : "";
    const detail = m.summary ? `\n  ${m.summary}` : "";
    return `- ${time}: ${title}${owner}${detail}`;
  });

  const header =
    meetings.length === 1
      ? `On ${range.label}, Wolfpack had 1 meeting:`
      : `On ${range.label}, Wolfpack had ${meetings.length} meetings:`;

  /* Surface related SharePoint / OneDrive / Project documents for the
     same window. Zero LLM tokens — getRelevantContext is pure retrieval
     (Graph search + Postgres). The user gets richer "here's everything
     M365 knows about this day" context without paying for the model. */
  let relatedBlock = "";
  if (args.userId) {
    try {
      const ctx = await getRelevantContext({
        question: args.question,
        userId: args.userId,
        role: "user",
        surface: "assistant_support",
        maxChars: 1500,
      });
      const sp = ctx.sharepoint_hits.slice(0, 3);
      if (sp.length > 0) {
        const spLines = sp
          .map((h) => `- [${h.title}](${h.url})`)
          .join("\n");
        relatedBlock = `\n\n**Related documents (SharePoint / OneDrive):**\n${spLines}`;
      }
    } catch {
      /* best-effort enrichment */
    }
  }

  const answer = `${header}\n${lines.join("\n")}${relatedBlock}\n\nGo to: [Meetings](/meetings)`;

  return {
    answer,
    meetings,
    dateLabel: range.label,
    startMs: range.startMs,
    endMs: range.endMs,
  };
}
