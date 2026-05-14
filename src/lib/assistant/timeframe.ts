/**
 * Deterministic timeframe-token → [startMs, endMs] resolver.
 * No LLM required — called from every calendar / finance / brain tool
 * so the assistant interprets "this afternoon" consistently everywhere.
 *
 * Accepts both canonical underscore tokens ("next_week", "this_quarter")
 * and free-text phrases captured by intent regexes ("Monday",
 * "Monday of next week", "next Tuesday", "this week", "for tomorrow").
 *
 * When the input doesn't match any known shape, returns today with
 * `resolved: false` so callers can surface a clarifying prompt.
 */

const MS_HOUR = 3600_000;
const MS_DAY = 24 * MS_HOUR;

export interface TimeRange {
  startMs: number;
  endMs: number;
  label: string;
  /** True when the input parsed cleanly; false when we defaulted to today. */
  resolved?: boolean;
}

const WEEKDAY_NAMES: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, weds: 3,
  thursday: 4, thu: 4, thurs: 4, thur: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

function dayBounds(nowMs: number): { startMs: number; endMs: number } {
  const d = new Date(nowMs);
  const startMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return { startMs, endMs: startMs + MS_DAY - 1 };
}

function singleDayBounds(year: number, month: number, day: number): { startMs: number; endMs: number } {
  const s = Date.UTC(year, month, day);
  return { startMs: s, endMs: s + MS_DAY - 1 };
}

/**
 * "monday" → upcoming Monday (today if today is Monday).
 * "next monday" / "monday of next week" → next week's Monday.
 * "this monday" / "monday of this week" → this week's Monday (may be past).
 * "last monday" / "monday of last week" → last week's Monday.
 */
function parseWeekdayPhrase(token: string, nowMs: number): TimeRange | null {
  const t = token.toLowerCase().trim();
  const m = /^(?:(this|next|last)\s+)?([a-z]+?)(?:\s+(?:of\s+)?(this|next|last)\s+week)?$/.exec(t);
  if (!m) return null;
  const leadQualifier = m[1];
  const dayName = m[2];
  const trailQualifier = m[3];
  const targetDow = WEEKDAY_NAMES[dayName];
  if (targetDow === undefined) return null;
  const qualifier = trailQualifier ?? leadQualifier ?? null;

  const now = new Date(nowMs);
  const todayDow = now.getUTCDay();
  let offsetDays: number;
  if (qualifier === "next") {
    offsetDays = (7 - todayDow) + targetDow;
  } else if (qualifier === "last") {
    offsetDays = -todayDow - 7 + targetDow;
  } else if (qualifier === "this") {
    offsetDays = targetDow - todayDow;
  } else {
    offsetDays = (targetDow - todayDow + 7) % 7;
  }

  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays));
  const range = singleDayBounds(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate());
  const labelDay = dayName.charAt(0).toUpperCase() + dayName.slice(1);
  let label: string;
  if (qualifier === "next") label = `${labelDay} of next week`;
  else if (qualifier === "last") label = `${labelDay} of last week`;
  else if (qualifier === "this") label = `${labelDay} of this week`;
  else if (offsetDays === 0) label = `today (${labelDay})`;
  else label = labelDay;

  return { ...range, label, resolved: true };
}

/**
 * Strip leading prepositions ("on Monday" → "Monday"),
 * trailing punctuation, and collapse internal whitespace.
 */
function normalizeToken(token: string): string {
  return token
    .toLowerCase()
    .trim()
    .replace(/^\s*(?:on|for|the|in|during)\s+/, "")
    .replace(/[?.!,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function resolveTimeframe(token: string | undefined, nowMs = Date.now()): TimeRange {
  const today = dayBounds(nowMs);
  if (!token) {
    return { ...today, label: "today", resolved: false };
  }

  const raw = normalizeToken(token);
  if (!raw) {
    return { ...today, label: "today", resolved: false };
  }

  const weekday = parseWeekdayPhrase(raw, nowMs);
  if (weekday) return weekday;

  const fixed = raw.replace(/\s+/g, "_");

  switch (fixed) {
    case "morning_today":
    case "this_morning":
      return { startMs: today.startMs, endMs: today.startMs + 12 * MS_HOUR - 1, label: "this morning", resolved: true };
    case "afternoon_today":
    case "this_afternoon":
      return { startMs: today.startMs + 12 * MS_HOUR, endMs: today.startMs + 18 * MS_HOUR - 1, label: "this afternoon", resolved: true };
    case "evening_today":
    case "this_evening":
    case "tonight":
      return { startMs: today.startMs + 18 * MS_HOUR, endMs: today.endMs, label: "this evening", resolved: true };
    case "tomorrow": {
      const s = today.startMs + MS_DAY;
      return { startMs: s, endMs: s + MS_DAY - 1, label: "tomorrow", resolved: true };
    }
    case "yesterday": {
      const s = today.startMs - MS_DAY;
      return { startMs: s, endMs: s + MS_DAY - 1, label: "yesterday", resolved: true };
    }
    case "this_week": {
      const d = new Date(nowMs);
      const dow = d.getUTCDay();
      const s = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow);
      return { startMs: s, endMs: s + 7 * MS_DAY - 1, label: "this week", resolved: true };
    }
    case "next_week": {
      const d = new Date(nowMs);
      const dow = d.getUTCDay();
      const s = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow + 7);
      return { startMs: s, endMs: s + 7 * MS_DAY - 1, label: "next week", resolved: true };
    }
    case "last_week": {
      const d = new Date(nowMs);
      const dow = d.getUTCDay();
      const s = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow - 7);
      return { startMs: s, endMs: s + 7 * MS_DAY - 1, label: "last week", resolved: true };
    }
    case "this_month": {
      const d = new Date(nowMs);
      const s = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
      const e = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - 1;
      return { startMs: s, endMs: e, label: "this month", resolved: true };
    }
    case "last_month": {
      const d = new Date(nowMs);
      const s = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
      const e = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 1;
      return { startMs: s, endMs: e, label: "last month", resolved: true };
    }
    case "next_month": {
      const d = new Date(nowMs);
      const s = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
      const e = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 1) - 1;
      return { startMs: s, endMs: e, label: "next month", resolved: true };
    }
    case "this_quarter": {
      const d = new Date(nowMs);
      const q = Math.floor(d.getUTCMonth() / 3);
      const s = Date.UTC(d.getUTCFullYear(), q * 3, 1);
      const e = Date.UTC(d.getUTCFullYear(), q * 3 + 3, 1) - 1;
      return { startMs: s, endMs: e, label: "this quarter", resolved: true };
    }
    case "last_quarter": {
      const d = new Date(nowMs);
      const q = Math.floor(d.getUTCMonth() / 3) - 1;
      const yr = q < 0 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
      const qq = ((q % 4) + 4) % 4;
      const s = Date.UTC(yr, qq * 3, 1);
      const e = Date.UTC(yr, qq * 3 + 3, 1) - 1;
      return { startMs: s, endMs: e, label: "last quarter", resolved: true };
    }
    case "this_year": {
      const d = new Date(nowMs);
      return {
        startMs: Date.UTC(d.getUTCFullYear(), 0, 1),
        endMs: Date.UTC(d.getUTCFullYear() + 1, 0, 1) - 1,
        label: "this year",
        resolved: true,
      };
    }
    case "last_year": {
      const d = new Date(nowMs);
      return {
        startMs: Date.UTC(d.getUTCFullYear() - 1, 0, 1),
        endMs: Date.UTC(d.getUTCFullYear(), 0, 1) - 1,
        label: "last year",
        resolved: true,
      };
    }
    case "today":
      return { ...today, label: "today", resolved: true };
    default:
      return { ...today, label: "today", resolved: false };
  }
}
