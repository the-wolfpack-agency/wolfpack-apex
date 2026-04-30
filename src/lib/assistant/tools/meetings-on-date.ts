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

const MS_DAY = 24 * 3_600_000;

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
): { startMs: number; endMs: number; label: string } | null {
  const q = text.trim();

  // ISO: 2026-04-21
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(q);
  if (iso) {
    const [, y, m, d] = iso;
    return dayBounds(Number(y), Number(m) - 1, Number(d));
  }

  // US: 4/21/2026 or 04/21/26
  const us = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/.exec(q);
  if (us) {
    const [, m, d, yr] = us;
    let y = Number(yr);
    if (y < 100) y += 2000;
    return dayBounds(y, Number(m) - 1, Number(d));
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
      return dayBounds(year, monthIdx, day);
    }
  }

  return null;
}

function dayBounds(
  y: number,
  monthIdx: number,
  day: number,
): { startMs: number; endMs: number; label: string } {
  const startMs = Date.UTC(y, monthIdx, day);
  const endMs = startMs + MS_DAY - 1;
  const label = new Date(startMs).toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return { startMs, endMs, label };
}

export async function runMeetingsOnDate(args: {
  question: string;
  nowMs?: number;
}): Promise<MeetingsOnDateResult | null> {
  const range = extractExplicitDate(args.question, args.nowMs ?? Date.now());
  if (!range) return null;
  if (!process.env.DATABASE_URL) return null;

  const { rows } = await safeQuery<{
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
  );

  const meetings: MeetingOnDateRow[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    summary: r.summary,
    recordedAt: r.recorded_at,
    durationSeconds: r.duration_seconds,
    ownerName: r.owner_name,
  }));

  if (meetings.length === 0) {
    return {
      answer: `No meetings recorded on ${range.label}.`,
      meetings,
      dateLabel: range.label,
      startMs: range.startMs,
      endMs: range.endMs,
    };
  }

  const lines = meetings.map((m) => {
    const time = m.recordedAt
      ? new Date(m.recordedAt).toLocaleTimeString("en-US", {
          timeZone: "UTC",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        })
      : "time unknown";
    const title = m.title ?? "Untitled meeting";
    const owner = m.ownerName ? ` — ${m.ownerName}` : "";
    return `- ${time} UTC: ${title}${owner}`;
  });

  const header =
    meetings.length === 1
      ? `On ${range.label}, Wolfpack had 1 meeting:`
      : `On ${range.label}, Wolfpack had ${meetings.length} meetings:`;
  const answer = `${header}\n${lines.join("\n")}\n\nGo to: [Meetings](/meetings)`;

  return {
    answer,
    meetings,
    dateLabel: range.label,
    startMs: range.startMs,
    endMs: range.endMs,
  };
}
