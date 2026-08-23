/**
 * Where the calendar is costing more than it returns.
 *
 * Every tool in this category counts meetings. Counting meetings is not
 * the finding, because nobody with a full calendar is unaware that it is
 * full. What they cannot see, because no calendar view shows it, is the
 * shape of what is left over.
 *
 * THE CENTRAL NUMBER
 *
 * Twenty-two unbooked hours in a week sounds like plenty of time to do
 * the work. If those hours arrive as eleven separate two-hour gaps that
 * is a good week, and if they arrive as twenty-two forty-minute gaps it
 * is a week in which nothing requiring concentration can be finished at
 * all. The totals are identical. Nobody is measuring the difference, and
 * it is the difference that people actually experience as a bad week.
 *
 * So the unit here is the USABLE BLOCK rather than the free hour.
 *
 * WHAT THIS IS NOT
 *
 * It is not a productivity score and it does not tell anyone they are
 * doing badly. Every finding is a fact about the shape of a week with
 * the arithmetic attached, because the person reading it knows things
 * about their own job that no scheduler does, and the ones who would
 * benefit most are the ones who would close a tool that scolded them.
 *
 * Pure functions over plain events, so the rules can be argued with in
 * a test rather than against a live mailbox.
 */

import { resolveIanaZone } from "@/lib/calendar/timezone";

/** The minimum uninterrupted stretch that useful work fits into. */
export const USABLE_BLOCK_MINUTES = 90;
/** Under this, two meetings are effectively one long meeting. */
export const BACK_TO_BACK_GAP_MINUTES = 10;
/** A run of this many with no real gap is the thing people feel. */
export const RUN_LENGTH = 3;

export interface ScheduleEvent {
  subject: string;
  /** ISO datetime. */
  start: string;
  /** ISO datetime. */
  end: string;
  attendees?: string[];
  /** Graph's free/tentative/busy/oof marker, where the source has one. */
  showAs?: string | null;
  isCancelled?: boolean;
  isAllDay?: boolean;
  /** This person's answer to the invitation. */
  responseStatus?: string | null;
}

/**
 * Is this an hour somebody actually spends in a room with other people?
 *
 * Everything here was counted as a meeting until the calendar was read
 * from something Graph-shaped rather than from a fixture:
 *
 *   - A CANCELLED occurrence stays on the calendar. Nobody attended it.
 *   - A meeting this person DECLINED is somebody else's meeting. Counting
 *     it charges them for an hour they deliberately kept.
 *   - A FREE or Focus Time block is Outlook protecting time to work in,
 *     and counting it as a meeting inverts the entire report: the very
 *     hours a person defended are billed to them as meetings, and the
 *     usable-block measure that is the point of this analysis falls.
 *   - OUT OF OFFICE is not a meeting either, and a week of it would
 *     otherwise read as the busiest week of somebody's year.
 *
 * Tentative counts. A maybe is still an hour that cannot be planned
 * around, which is what the report is measuring.
 */
function isRealMeeting(e: ScheduleEvent): boolean {
  if (e.isCancelled) return false;
  if (e.isAllDay) return false;
  const showAs = (e.showAs ?? "").toLowerCase();
  if (showAs === "free" || showAs === "oof" || showAs === "workingelsewhere") return false;
  if ((e.responseStatus ?? "").toLowerCase() === "declined") return false;
  return true;
}

/**
 * The zone every hour in this file is expressed in.
 *
 * Everything here used to call getHours(), which reads the SERVER's
 * clock. Vercel runs UTC, so a Detroit dealer asking which hours to
 * defend was told about somebody else's afternoon: the same week of
 * meetings produced 9am and 2pm in Detroit, 1pm and 4pm in UTC, and
 * thirty free hours against forty depending only on where the code
 * happened to be running. The single most actionable line this analysis
 * produces was wrong for everyone outside UTC.
 *
 * So the zone is an input, it comes from the person's own mailbox
 * settings, and the report says which one it used. A statement about
 * "9am" that does not say whose 9am is not worth acting on.
 */
export interface WorkingHours {
  /** Local hour work starts, inclusive. */
  startHour: number;
  /** Local hour work ends, exclusive. */
  endHour: number;
  /** 0=Sunday. Days not listed are not counted as available at all. */
  days: number[];
}

export const DEFAULT_HOURS: WorkingHours = {
  startHour: 9,
  endHour: 17,
  days: [1, 2, 3, 4, 5],
};

/** One event, expressed in the person's own local time. */
interface ZonedEvent {
  subject: string;
  /** Local calendar day, YYYY-MM-DD. */
  dayKey: string;
  /** 0=Sunday, in the person's zone. */
  weekday: number;
  /** Minutes from local midnight. */
  startMin: number;
  endMin: number;
  attendees: number;
  startMs: number;
  endMs: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/**
 * Local wall-clock parts for an instant.
 *
 * Intl is the only thing that gets DST right without a table, and the
 * alternative (adding a fixed offset) is wrong twice a year in every
 * zone that observes it.
 */
function zonedParts(ms: number, iana: string) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: iana,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
    weekday: "short",
  });
  const m: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(ms))) m[part.type] = part.value;
  /* en-CA renders midnight as 24 rather than 00 in some runtimes. */
  const hour = Number(m.hour) % 24;
  return {
    dayKey: `${m.year}-${m.month}-${m.day}`,
    weekday: WEEKDAY_INDEX[m.weekday] ?? 0,
    minutes: hour * 60 + Number(m.minute),
  };
}

export interface ScheduleReport {
  days: number;
  /** The zone every hour in this report is expressed in. */
  timeZone: string;
  meetings: number;
  meetingHours: number;
  /** Working hours in the window that hold no meeting. */
  freeHours: number;
  /** Free time in stretches long enough to be usable. */
  usableBlocks: number;
  usableHours: number;
  /** Free hours that arrived in stretches too short to use. */
  strandedHours: number;
  /** Runs of RUN_LENGTH+ meetings with no real gap between them. */
  backToBackRuns: number;
  longestRun: number;
  /** Hours a person spent in meetings that recur, per week. */
  recurringHoursPerWeek: number;
  heaviestRecurring?: { subject: string; occurrences: number; hoursPerWeek: number };
  /** Attendee-hours: the cost to the organisation, not to one diary. */
  attendeeHours: number;
  /** Hour-of-day slots most often free, best first. */
  bestFocusHours: number[];
  /** Hour-of-day slots most often busy, worst first. */
  busiestHours: number[];
  /** Weekday indices with no meeting at all in the window. */
  clearDays: number[];
}

const MS_PER_MIN = 60_000;

function minutes(a: string, b: string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / MS_PER_MIN;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * A recurring series, identified by subject.
 *
 * Graph exposes a series id, and using it would be better. Subject is
 * used because it is the one field every source of events has, and this
 * has to work against a CRM calendar and an exported ICS as well as
 * against Graph. Two genuinely different meetings sharing a subject get
 * merged, which overstates a series slightly; the alternative is
 * missing every series from every source that does not expose one.
 */
function seriesKey(subject: string): string {
  return subject.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Free stretches inside working hours, per local day.
 *
 * Built per day because the overnight gap between Tuesday evening and
 * Wednesday morning is not a fourteen-hour opportunity to concentrate.
 * "Day" now means the person's local day, which is the only definition
 * that matches what they experienced.
 */
function freeStretches(events: ZonedEvent[], hours: WorkingHours): number[] {
  const openMin = hours.startHour * 60;
  const closeMin = hours.endHour * 60;

  const byDay = new Map<string, ZonedEvent[]>();
  for (const e of events) {
    if (!hours.days.includes(e.weekday)) continue;
    byDay.set(e.dayKey, [...(byDay.get(e.dayKey) ?? []), e]);
  }

  const stretches: number[] = [];
  for (const dayEvents of byDay.values()) {
    const sorted = [...dayEvents].sort((a, b) => a.startMin - b.startMin);
    let cursor = openMin;
    for (const e of sorted) {
      const s = Math.max(e.startMin, openMin);
      const en = Math.min(e.endMin, closeMin);
      if (s > cursor) stretches.push(s - cursor);
      cursor = Math.max(cursor, en);
    }
    if (closeMin > cursor) stretches.push(closeMin - cursor);
  }
  return stretches.filter((m) => m > 0);
}

export function analyseSchedule(
  events: ScheduleEvent[],
  opts: { days?: number; hours?: WorkingHours; timeZone?: string | null } = {},
): ScheduleReport {
  const hours = opts.hours ?? DEFAULT_HOURS;
  const days = opts.days ?? 7;
  const iana = resolveIanaZone(opts.timeZone) ?? "UTC";

  const valid: ZonedEvent[] = [];
  for (const e of events) {
    if (!isRealMeeting(e)) continue;
    const startMs = Date.parse(e.start);
    const endMs = Date.parse(e.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    const durationMin = (endMs - startMs) / MS_PER_MIN;
    /* Zero-length and all-day entries are markers rather than meetings.
       An all-day "Out of office" counted as eight meeting-hours would
       swamp every other number in the report. */
    if (!(durationMin > 0 && durationMin < 8 * 60)) continue;

    const p = zonedParts(startMs, iana);
    valid.push({
      subject: e.subject,
      dayKey: p.dayKey,
      weekday: p.weekday,
      startMin: p.minutes,
      /* Derived from the absolute duration rather than from a second
         lookup, so an event running across a DST boundary keeps its
         real length instead of gaining or losing an hour. */
      endMin: p.minutes + durationMin,
      attendees: Math.max(1, e.attendees?.length ?? 1),
      startMs,
      endMs,
    });
  }

  const meetingMinutes = valid.reduce((n, e) => n + (e.endMs - e.startMs) / MS_PER_MIN, 0);
  const attendeeMinutes = valid.reduce(
    (n, e) => n + ((e.endMs - e.startMs) / MS_PER_MIN) * e.attendees,
    0,
  );

  const stretches = freeStretches(valid, hours);
  const usable = stretches.filter((m) => m >= USABLE_BLOCK_MINUTES);
  const stranded = stretches.filter((m) => m < USABLE_BLOCK_MINUTES);

  /* Runs. Sorted across the whole window; a run cannot span a night
     because the gap is enormous. */
  const sorted = [...valid].sort((a, b) => a.startMs - b.startMs);
  let runs = 0;
  let longest = 0;
  let current = sorted.length > 0 ? 1 : 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = (sorted[i].startMs - sorted[i - 1].endMs) / MS_PER_MIN;
    if (gap <= BACK_TO_BACK_GAP_MINUTES) {
      current++;
    } else {
      if (current >= RUN_LENGTH) runs++;
      longest = Math.max(longest, current);
      current = 1;
    }
  }
  if (current >= RUN_LENGTH) runs++;
  longest = Math.max(longest, current);

  /* Recurring series. */
  const series = new Map<string, { subject: string; occurrences: number; minutes: number }>();
  for (const e of valid) {
    const key = seriesKey(e.subject);
    const entry = series.get(key) ?? { subject: e.subject, occurrences: 0, minutes: 0 };
    entry.occurrences++;
    entry.minutes += (e.endMs - e.startMs) / MS_PER_MIN;
    series.set(key, entry);
  }
  const recurring = [...series.values()].filter((s) => s.occurrences > 1);
  const weeks = Math.max(days / 7, 1 / 7);
  const heaviest = [...recurring].sort((a, b) => b.minutes - a.minutes)[0];

  /* Hour-of-day availability across the window. */
  const busyByHour = new Map<number, number>();
  for (const e of valid) {
    const firstHour = Math.floor(e.startMin / 60);
    /* The last instant INSIDE the meeting, not the end boundary. A
       meeting finishing at 4pm does not make 4pm a busy hour, and
       counting it as one would have us telling people to defend the
       hour immediately after every meeting they have. */
    const lastHour = Math.floor((e.endMin - 1) / 60);
    for (let h = firstHour; h <= lastHour && h < hours.endHour; h++) {
      if (h < hours.startHour) continue;
      busyByHour.set(h, (busyByHour.get(h) ?? 0) + 1);
    }
  }
  const workHourList: number[] = [];
  for (let h = hours.startHour; h < hours.endHour; h++) workHourList.push(h);
  const ranked = [...workHourList].sort(
    (a, b) => (busyByHour.get(a) ?? 0) - (busyByHour.get(b) ?? 0),
  );

  const daysWithMeetings = new Set(valid.map((e) => e.weekday));
  const clearDays = hours.days.filter((d) => !daysWithMeetings.has(d));

  return {
    days,
    timeZone: iana,
    meetings: valid.length,
    meetingHours: round1(meetingMinutes / 60),
    freeHours: round1(stretches.reduce((n, m) => n + m, 0) / 60),
    usableBlocks: usable.length,
    usableHours: round1(usable.reduce((n, m) => n + m, 0) / 60),
    strandedHours: round1(stranded.reduce((n, m) => n + m, 0) / 60),
    backToBackRuns: runs,
    longestRun: longest,
    recurringHoursPerWeek: round1(
      recurring.reduce((n, s) => n + s.minutes, 0) / 60 / weeks,
    ),
    heaviestRecurring: heaviest
      ? {
          subject: heaviest.subject,
          occurrences: heaviest.occurrences,
          hoursPerWeek: round1(heaviest.minutes / 60 / weeks),
        }
      : undefined,
    attendeeHours: round1(attendeeMinutes / 60),
    bestFocusHours: ranked.slice(0, 3),
    busiestHours: [...ranked].reverse().slice(0, 3),
    clearDays,
  };
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function hourLabel(h: number): string {
  const period = h < 12 ? "am" : "pm";
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}${period}`;
}

/**
 * The report as a colleague would put it, leading with the number
 * nobody else is showing them.
 */
export function renderSchedule(r: ScheduleReport): string {
  if (r.meetings === 0) {
    return `No meetings in the last ${r.days} days, so there is nothing here to improve on.`;
  }

  const lines: string[] = [];

  lines.push(
    `Across ${r.days} days: ${r.meetings} meetings, ${r.meetingHours}h in the room, ` +
      `${r.freeHours}h unbooked.`,
    "",
  );

  /* The headline. Free hours are the number people already have; usable
     blocks are the number that decides whether the week worked. */
  if (r.strandedHours > 0) {
    lines.push(
      `**${r.usableHours}h of that is actually usable.** The unbooked time arrived as ` +
        `${r.usableBlocks} stretch${r.usableBlocks === 1 ? "" : "es"} long enough to finish ` +
        `something in, and ${r.strandedHours}h in pieces too short to start anything that ` +
        `needs concentration.`,
    );
  } else {
    lines.push(
      `All ${r.freeHours}h of the unbooked time came in usable stretches, which is rarer ` +
        `than it sounds.`,
    );
  }

  if (r.backToBackRuns > 0) {
    lines.push(
      "",
      `**Back to back:** ${r.backToBackRuns} run${r.backToBackRuns === 1 ? "" : "s"} of ` +
        `${RUN_LENGTH} or more with no real gap, the longest being ${r.longestRun} in a row. ` +
        `That is where the day stops having any slack in it.`,
    );
  }

  if (r.heaviestRecurring && r.heaviestRecurring.occurrences > 1) {
    const h = r.heaviestRecurring;
    lines.push(
      "",
      `**The standing cost:** "${h.subject}" ran ${h.occurrences} times, about ` +
        `${h.hoursPerWeek}h a week of your time. Across everyone invited, meetings in this ` +
        `window cost ${r.attendeeHours} attendee-hours.`,
    );
  }

  lines.push(
    "",
    /* Naming the zone is not pedantry. The hours in this paragraph are
       the whole point of the analysis, and a reader in Detroit being
       shown UTC afternoons would act on them once and never open it
       again. */
    `**When to protect** (times in ${r.timeZone}): ` +
      `${r.bestFocusHours.map(hourLabel).join(", ")} are the least ` +
      `booked hours in this window, so they are the ones to defend. ` +
      `${r.busiestHours.map(hourLabel).join(", ")} are the busiest, which makes them the ` +
      `cheapest place to put a meeting that has to happen.`,
  );

  if (r.clearDays.length > 0) {
    lines.push(
      "",
      `${r.clearDays.map((d) => DAY_NAMES[d]).join(" and ")} had no meetings at all. ` +
        `Keeping it that way is worth more than reclaiming the same hours spread thin.`,
    );
  }

  return lines.join("\n");
}
