/**
 * When a routine should next run.
 *
 * The piece that turns something you type into something that meets you: "the
 * day before, prep the brief" only works if the product knows what tomorrow
 * means for the person waiting.
 *
 * PURE, AND THE CLOCK IS AN ARGUMENT
 *
 * Every function here takes `now`. Nothing reads the system clock, so the
 * interesting cases (a Sunday, the last day of a month, the hour a country
 * changes its offset) are tested exactly rather than approximately. Time
 * arithmetic that can only be tested by waiting is time arithmetic that stays
 * wrong.
 *
 * TIME ZONES ARE THE POINT, NOT A DETAIL
 *
 * "Eight in the morning" is a promise about the person's morning, not about
 * UTC. A schedule stored as a UTC hour is correct until the clocks change and
 * then silently an hour out for everybody, in the direction nobody notices
 * until a briefing arrives after the meeting. So the local hour and the zone
 * are stored, and the next occurrence is computed against that zone every
 * time, using Intl rather than a table of offsets that goes stale.
 */

export type Cadence = "daily" | "weekdays" | "weekly";

export interface Schedule {
  cadence: Cadence;
  /** 0 to 23, in the person's own zone. */
  hour: number;
  /** IANA zone, e.g. "America/New_York". */
  timeZone: string;
  /** For "weekly": 0 is Sunday, matching Date.getDay. */
  weekday?: number;
}

/** The parts of an instant, as they read in a given zone. */
function partsIn(timeZone: string, at: Date): { y: number; m: number; d: number; h: number; min: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    /* "24" appears at midnight in some locales' hour12:false output. */
    h: Number(parts.hour) % 24,
    min: Number(parts.minute),
    weekday: days.indexOf(String(parts.weekday)),
  };
}

/** The offset of a zone at an instant, in minutes. */
function offsetMinutes(timeZone: string, at: Date): number {
  const p = partsIn(timeZone, at);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
  return (asUtc - at.getTime()) / 60000;
}

/**
 * The instant at which a given local wall-clock time occurs.
 *
 * Two passes, deliberately. The first guesses using the offset in force NOW,
 * the second corrects using the offset in force at the guessed instant. Without
 * the second pass every schedule crossing a daylight-saving boundary is an hour
 * out, which is exactly the failure that arrives quietly and only in spring.
 */
function instantFor(timeZone: string, y: number, m: number, d: number, hour: number): Date {
  const naive = Date.UTC(y, m - 1, d, hour, 0, 0, 0);
  const guess = new Date(naive - offsetMinutes(timeZone, new Date(naive)) * 60000);
  return new Date(naive - offsetMinutes(timeZone, guess) * 60000);
}

/** Monday to Friday in the person's own zone, not in UTC. */
function isWeekday(weekday: number): boolean {
  return weekday >= 1 && weekday <= 5;
}

/**
 * The next time this schedule is due, strictly after `now`.
 *
 * Strictly after matters: a run that has just happened must not be due again on
 * the same tick, or a schedule fires in a loop for an hour.
 */
export function nextRun(schedule: Schedule, now: Date): Date {
  const { cadence, hour, timeZone } = schedule;
  const start = partsIn(timeZone, now);

  /* Up to fourteen days ahead is enough for every cadence here, and a bounded
     loop cannot hang a cron sweep on an unsatisfiable schedule. */
  for (let add = 0; add <= 14; add += 1) {
    /* Adding days at noon avoids landing inside a daylight-saving gap while
       walking the calendar; the hour is applied afterwards. */
    const probe = new Date(Date.UTC(start.y, start.m - 1, start.d + add, 12));
    const p = partsIn(timeZone, probe);

    if (cadence === "weekdays" && !isWeekday(p.weekday)) continue;
    if (cadence === "weekly" && p.weekday !== (schedule.weekday ?? 1)) continue;

    const candidate = instantFor(timeZone, p.y, p.m, p.d, hour);
    if (candidate.getTime() > now.getTime()) return candidate;
  }

  /* Unreachable for the cadences above. Returning a day out rather than
     throwing keeps a malformed row from taking down a sweep for everybody. */
  return new Date(now.getTime() + 86_400_000);
}

/** Human wording, for confirming a schedule back to the person. */
export function describeSchedule(schedule: Schedule): string {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const h = schedule.hour;
  const clock = h === 0 ? "midnight" : h === 12 ? "midday" : h < 12 ? `${h}am` : `${h - 12}pm`;
  if (schedule.cadence === "daily") return `every day at ${clock}`;
  if (schedule.cadence === "weekdays") return `every weekday at ${clock}`;
  return `every ${days[schedule.weekday ?? 1]} at ${clock}`;
}

/** Zones we will accept. A bad zone must fail on the way in, not at 6am. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const CADENCE_WORDS: Array<{ re: RegExp; cadence: Cadence; weekday?: number }> = [
  { re: /\bevery\s+weekday\b|\bon\s+weekdays\b|\bevery\s+working\s+day\b/i, cadence: "weekdays" },
  { re: /\bevery\s+day\b|\bdaily\b|\beach\s+day\b/i, cadence: "daily" },
  { re: /\bevery\s+sunday\b/i, cadence: "weekly", weekday: 0 },
  { re: /\bevery\s+monday\b/i, cadence: "weekly", weekday: 1 },
  { re: /\bevery\s+tuesday\b/i, cadence: "weekly", weekday: 2 },
  { re: /\bevery\s+wednesday\b/i, cadence: "weekly", weekday: 3 },
  { re: /\bevery\s+thursday\b/i, cadence: "weekly", weekday: 4 },
  { re: /\bevery\s+friday\b/i, cadence: "weekly", weekday: 5 },
  { re: /\bevery\s+saturday\b/i, cadence: "weekly", weekday: 6 },
];

/* "at 8", "at 8am", "at 08:30" (minutes are read and deliberately dropped: a
   schedule that claims 8:37 implies a precision a cron sweep does not have). */
const TIME_RE = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;

/**
 * Read a schedule out of a sentence.
 *
 * Returns null when there is no cadence AND time, rather than guessing.
 * A schedule invented from an ambiguous sentence is something that fires at
 * 3am forever, and nobody will connect it back to what they typed.
 */
export function parseSchedule(text: string, timeZone: string): Schedule | null {
  if (text.length > 300) return null;
  const found = CADENCE_WORDS.find((c) => c.re.test(text));
  if (!found) return null;

  const m = TIME_RE.exec(text);
  if (!m) return null;

  let hour = Number(m[1]);
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null;
  const meridiem = m[3]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  /* No meridiem and an hour under 7 is far more likely to be an evening than a
     pre-dawn start, but guessing either way is a schedule somebody did not ask
     for. Refuse and let them say which. */
  if (!meridiem && hour < 7) return null;

  return {
    cadence: found.cadence,
    hour,
    timeZone,
    ...(found.weekday !== undefined ? { weekday: found.weekday } : {}),
  };
}
