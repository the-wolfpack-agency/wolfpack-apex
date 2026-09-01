/**
 * How a week is actually spent, from the calendar we now hold.
 *
 * WHY THIS IS NEW CODE RATHER THAN A REPOINTED QUERY. learning/calendar-signals
 * reads instinct_calendar_events_written, and it was tempting to call that the
 * wrong table and move it to the synced one. It is not the wrong table. That
 * log records calendar writes INSTINCT ITSELF made, which is a real signal
 * about what the product did, and a different question from how somebody's
 * week went. Repointing it would have silently changed what an existing
 * extractor means.
 *
 * So the capability was missing rather than misrouted, and it could not be
 * built before because instinct_ms_events was empty until the sync was
 * scheduled and run.
 *
 * IT EXCLUDES WHAT IS NOT A MEETING, WHICH IS THE WHOLE DIFFICULTY. On our own
 * calendar, thirty entries of somebody being away and sixty-four trips held
 * ninety per cent of the hours. A load figure that counts them reports five and
 * a half thousand hours where the truth is five hundred and forty-seven, and
 * that number was on its way into a client document. Classification happens
 * here rather than in SQL so the rules stay in one tested place, and so a
 * client's own conventions can be passed in.
 *
 * TIME AWAY IS REPORTED, NOT DISCARDED. Who is off and when is the answer to
 * its own question, and dropping it would trade a wrong number for a missing
 * one.
 */

import {
  classifyCalendarEvent,
  type CalendarConventions,
  type CalendarEventShape,
} from "./calendar-kinds";

export interface PersonLoad {
  person: string;
  meetings: number;
  meetingHours: number;
  /** Meetings with nobody else invited are excluded from this. */
  withOthers: number;
  timeOffDays: number;
  /** Longest run of meetings with no gap, which is what a day feels like. */
  longestBackToBack: number;
}

export interface CalendarLoad {
  people: PersonLoad[];
  windowDays: number;
  /** Entries no figure could be computed from, counted rather than assumed. */
  unusable: number;
}

export interface LoadEvent extends CalendarEventShape {
  /** Whose calendar this entry sits on. */
  person: string;
  /**
   * Who created it, which for time off is the person actually away.
   *
   * A team invites everybody to its holidays: on our own calendar every OOO
   * entry appeared on all six calendars, so attributing time off to whoever
   * it appears for gave all six people an identical 12.6 days away, which is
   * everyone's holidays counted six times. A meeting is different and needs no
   * such rule: an attendee really did spend that hour.
   */
  organizer?: string | null;
}

const HOUR = 3_600_000;

function hours(startAt: string | null, endAt: string | null): number | null {
  if (!startAt || !endAt) return null;
  const a = Date.parse(startAt);
  const b = Date.parse(endAt);
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return null;
  return (b - a) / HOUR;
}

/**
 * The longest run of meetings that touch, per person.
 *
 * Counted rather than a percentage because "four in a row" is a thing
 * somebody recognizes about their own Tuesday, and "63% fragmentation" is
 * not. Two meetings count as a run of two only if the second starts when the
 * first ends or earlier; a five-minute gap breaks it, which is the point,
 * because five minutes is not a break.
 */
export function longestRun(events: readonly { startAt: string; endAt: string }[]): number {
  const sorted = [...events].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  let best = 0;
  let run = 0;
  let previousEnd = -Infinity;

  for (const e of sorted) {
    const start = Date.parse(e.startAt);
    const end = Date.parse(e.endAt);
    run = start <= previousEnd ? run + 1 : 1;
    best = Math.max(best, run);
    previousEnd = Math.max(previousEnd, end);
  }
  return best;
}

/**
 * Summarize a set of calendar entries per person.
 *
 * Pure, so the arithmetic that produces a number somebody quotes is testable
 * without a database.
 */
export function summarizeLoad(
  events: readonly LoadEvent[],
  windowDays: number,
  conventions: CalendarConventions = {},
): CalendarLoad {
  const byPerson = new Map<string, { meetings: LoadEvent[]; timeOffHours: number }>();
  let unusable = 0;

  for (const event of events) {
    const length = hours(event.startAt, event.endAt);
    if (length === null) {
      unusable += 1;
      continue;
    }
    const entry = byPerson.get(event.person) ?? { meetings: [], timeOffHours: 0 };
    switch (classifyCalendarEvent(event, conventions)) {
      case "meeting":
        entry.meetings.push(event);
        break;
      case "time-off":
        /* Only the organizer is away. Everybody else is looking at somebody
           else's holiday on their own calendar. */
        if (!event.organizer || event.organizer === event.person) {
          entry.timeOffHours += length;
        }
        break;
      default:
        /* Blocks and holds are neither meetings nor time away. Counted in
           neither figure rather than quietly folded into one. */
        break;
    }
    byPerson.set(event.person, entry);
  }

  const people: PersonLoad[] = [...byPerson.entries()]
    .map(([person, { meetings, timeOffHours }]) => ({
      person,
      meetings: meetings.length,
      meetingHours:
        Math.round(meetings.reduce((s, m) => s + (hours(m.startAt, m.endAt) ?? 0), 0) * 10) / 10,
      withOthers: meetings.filter((m) => (m.attendeeCount ?? 0) > 0).length,
      /* A working day, so "three days off" reads the way somebody says it. */
      timeOffDays: Math.round((timeOffHours / 8) * 10) / 10,
      longestBackToBack: longestRun(
        meetings
          .filter((m) => m.startAt && m.endAt)
          .map((m) => ({ startAt: m.startAt as string, endAt: m.endAt as string })),
      ),
    }))
    .sort((a, b) => b.meetingHours - a.meetingHours);

  return { people, windowDays, unusable };
}

/** What a person reads, with the caveats attached to the numbers. */
export function describeLoad(load: CalendarLoad): string {
  if (load.people.length === 0) {
    /* UNREADABLE IS NOT EMPTY, even when the result is the same size. Entries
       arrived and none could be used, which points at the data rather than at
       a quiet week, and returning the quiet-week sentence would send somebody
       to check the wrong thing. */
    if (load.unusable > 0) {
      return `${load.unusable} calendar entr(ies) had no usable times, so nothing could be computed. That is a problem with the entries rather than a quiet week.`;
    }
    return "No calendar entries in this window, which is not the same as a quiet one: check the calendar is being synced before reading anything into it.";
  }

  const lines = [`Meeting load over ${load.windowDays} days, per person:`, ``];
  for (const p of load.people) {
    const solo = p.meetings - p.withOthers;
    lines.push(
      `  ${p.person.padEnd(30)} ${String(p.meetings).padStart(4)} meetings  ${String(p.meetingHours).padStart(7)}h` +
        (p.longestBackToBack > 1 ? `  longest run ${p.longestBackToBack}` : "") +
        (solo > 0 ? `  (${solo} with nobody else invited)` : "") +
        (p.timeOffDays > 0 ? `  ${p.timeOffDays}d away` : ""),
    );
  }

  lines.push(
    ``,
    `Time away, trips and personal holds are excluded from the meeting figures. Including them`,
    `on this calendar would multiply the total roughly tenfold, which is the mistake this is`,
    `written to avoid rather than a hypothetical one.`,
  );
  if (load.unusable > 0) {
    lines.push(
      `${load.unusable} entr(ies) had no usable times and are in no figure above.`,
    );
  }
  return lines.join("\n");
}
