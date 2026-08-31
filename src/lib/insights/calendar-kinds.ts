/**
 * A calendar is not a list of meetings, and treating it as one is wrong by an
 * order of magnitude.
 *
 * MEASURED ON OUR OWN CALENDAR, 801 events across six people:
 *
 *   out of office        30 events    2,763 hours
 *   all-day blocks       64 events    2,304 hours
 *   actual meetings     707 events      557 hours
 *
 * Ninety-four entries, eleven per cent of the calendar, hold ninety per cent
 * of the hours, and none of them is a meeting. They are holidays, a trip, and
 * a week at a Grand Prix. A "how much time does this team spend in meetings"
 * figure that includes them reports five and a half thousand hours where the
 * truth is five hundred and fifty-seven.
 *
 * That number would have gone in front of a client. It was caught because
 * somebody who knows this calendar said that an OOO entry is a vacation day,
 * which is the kind of thing no amount of reading the data reveals: the events
 * are well formed and the arithmetic is correct.
 *
 * TIME OFF IS NOT NOISE TO BE DROPPED. It is its own answer, to its own
 * question: who is away, when, and where the cover has gaps. It is classified
 * out of the meeting figures and kept, rather than filtered away.
 *
 * NAME AND SHAPE ARE BOTH NEEDED. "Alicia OOO" says what it is; "F1 Las
 * Vegas" and "Avryl Trip" do not, and are only distinguishable as
 * non-meetings by lasting a hundred and ninety-two hours. Either signal alone
 * misses most of the total.
 */

export type CalendarKind =
  /** A real meeting between people. */
  | "meeting"
  /** Somebody is away: holiday, leave, out of office. */
  | "time-off"
  /** A multi-day block that is not a meeting: travel, an event, a conference. */
  | "multi-day-block"
  /** A hold on somebody's own time: focus, lunch, no-meeting blocks. */
  | "personal-hold";

export interface CalendarEventShape {
  subject: string | null;
  startAt: string | null;
  endAt: string | null;
  /** How many people were invited. A hold has none. */
  attendeeCount?: number;
}

/**
 * Words that say the entry is somebody being away.
 *
 * Bounded by word edges so "Portfolio Optimisation Overview" does not match
 * on the letters of a leave word, and deliberately short: a list long enough
 * to catch every phrasing would catch meetings about leave policy too.
 */
const TIME_OFF =
  /(^|\W)(ooo|o\.o\.o|out of office|pto|vacation|holiday|annual leave|day off|on leave|sick|parental leave|sabbatical)(\W|$)/i;

/**
 * Words that make it an appointment ABOUT something, not the thing itself.
 *
 * "Review the holiday policy draft" contains a leave word and is a meeting.
 * Checked before the leave words, because a meeting discussing time off is
 * still a meeting and counting it as somebody's holiday removes real meeting
 * hours as well as inventing leave that nobody took.
 */
const ABOUT_A_TOPIC =
  /(^|\W)(review|policy|planning|plan|discussion|discuss|sync|standup|stand-up|call|meeting|catch[- ]?up|1:1|one[- ]on[- ]one|workshop|training|kickoff|retro|demo)(\W|$)/i;

/** A hold somebody puts on their own time rather than an appointment. */
const PERSONAL_HOLD =
  /(^|\W)(focus time|focus block|do not book|no meetings|lunch|blocked|hold|busy|travel time|commute|prep time)(\W|$)/i;

/**
 * Hours beyond which an entry cannot be an ordinary meeting.
 *
 * Twenty. An all-day entry is twenty-four and a genuinely long workshop is
 * eight, so twenty separates them without argument and without excluding the
 * longest real meeting anybody runs.
 */
export const NOT_A_MEETING_HOURS = 20;

function hoursBetween(startAt: string | null, endAt: string | null): number | null {
  if (!startAt || !endAt) return null;
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return (end - start) / 3_600_000;
}

/**
 * What this entry actually is.
 *
 * Name first, because a person naming their entry is the most reliable signal
 * there is. Shape second, for the ones nobody labelled.
 */
export function classifyCalendarEvent(
  event: CalendarEventShape,
  conventions: CalendarConventions = {},
): CalendarKind {
  const subject = event.subject ?? "";
  const matchesAny = (patterns: RegExp[] | undefined) =>
    (patterns ?? []).some((re) => re.test(subject));

  /* An appointment about a topic is a meeting, whatever the topic is. */
  const aboutSomething = ABOUT_A_TOPIC.test(subject);

  /* This organisation's own vocabulary first: it knows itself better than a
     built-in list does. */
  if (matchesAny(conventions.timeOff) && !aboutSomething) return "time-off";
  if (matchesAny(conventions.notAMeeting)) return "multi-day-block";

  if (TIME_OFF.test(subject) && !aboutSomething) return "time-off";

  const hours = hoursBetween(event.startAt, event.endAt);
  if (hours !== null && hours >= NOT_A_MEETING_HOURS) {
    /* Long AND unlabelled. A trip, a conference, a week at a race: not a
       meeting, and not somebody's leave either, so it is neither counted as
       meeting time nor reported as time off. */
    return "multi-day-block";
  }

  if (matchesAny(conventions.hold) || PERSONAL_HOLD.test(subject)) return "personal-hold";

  /* An entry with nobody else invited is a note to self rather than a
     meeting, however it is named. Checked last so a labelled one-person
     holiday is still time off. */
  if (event.attendeeCount === 0 && hours !== null && hours >= 4) return "personal-hold";

  return "meeting";
}

/**
 * Patterns that mean something particular to ONE organisation.
 *
 * Ours needed none: "OOO" is universal enough to be built in. A client's will
 * not be. A dealership marks floor duty and demo drives on the same calendar
 * as meetings; an agency blocks "shoot day"; somebody prefixes every
 * placeholder with "[HOLD]". None of that is guessable and all of it changes
 * the numbers.
 *
 * Supplied per deployment rather than added to the built-in lists, because a
 * pattern that is right for one client is wrong for the next: "demo" means a
 * test drive at a dealership and a sales meeting everywhere else.
 */
export interface CalendarConventions {
  /** Extra ways this organisation says somebody is away. */
  timeOff?: RegExp[];
  /** Extra ways it marks a block on its own time. */
  hold?: RegExp[];
  /** Extra ways it marks something that is not a meeting at all. */
  notAMeeting?: RegExp[];
}

/**
 * The signature of a convention nobody has told us about yet.
 *
 * A handful of entries holding most of the hours is what an unlabelled
 * convention looks like from outside. On our own calendar, ninety-four of 801
 * entries held ninety per cent of the time and every one was a holiday or a
 * trip. The data was well formed and the arithmetic was correct, which is
 * exactly why nothing flagged it.
 *
 * The share and the threshold are separate on purpose: two long workshops in
 * a quiet week are not a convention, and a hundred entries holding sixty per
 * cent is not either.
 */
export const DOMINANCE_SHARE = 0.5;
export const DOMINANCE_ENTRY_SHARE = 0.25;

export interface Concentration {
  /** True when few entries hold most of the hours. */
  dominated: boolean;
  /** How many entries account for DOMINANCE_SHARE of the total. */
  entries: number;
  totalEntries: number;
  /** Their subjects, so the question can name them. */
  examples: string[];
}

/**
 * Find whether a few entries dominate, and name them.
 *
 * This is what gets ASKED at onboarding. It cannot say what those entries
 * are, and must not guess: it says which ones carry the weight and leaves the
 * answer to somebody who knows the calendar.
 */
export function findConcentration(events: readonly CalendarEventShape[]): Concentration {
  const timed = events
    .map((e) => ({ subject: e.subject ?? "(untitled)", hours: hoursBetween(e.startAt, e.endAt) ?? 0 }))
    .filter((e) => e.hours > 0)
    .sort((a, b) => b.hours - a.hours);

  const total = timed.reduce((s, e) => s + e.hours, 0);
  if (total === 0 || timed.length === 0) {
    return { dominated: false, entries: 0, totalEntries: timed.length, examples: [] };
  }

  let running = 0;
  let entries = 0;
  for (const e of timed) {
    running += e.hours;
    entries += 1;
    if (running / total >= DOMINANCE_SHARE) break;
  }

  return {
    dominated: entries / timed.length <= DOMINANCE_ENTRY_SHARE,
    entries,
    totalEntries: timed.length,
    examples: timed.slice(0, 5).map((e) => e.subject),
  };
}

/**
 * The question to put to somebody who knows this calendar.
 *
 * Phrased as a question because it IS one. Our own quirk was found by a person
 * saying "anyone whose meeting says OOO is just a vacation day", which no
 * amount of reading the data would have produced.
 */
export function calibrationQuestion(c: Concentration): string | null {
  if (!c.dominated) return null;
  return [
    `${c.entries} of ${c.totalEntries} calendar entries account for more than half the hours.`,
    `That is usually a local convention rather than a busy team: an entry that is not a meeting,`,
    `sitting on the same calendar as meetings.`,
    ``,
    `The largest are: ${c.examples.join(", ")}.`,
    ``,
    `Before any figure about meeting time is quoted, somebody who knows this calendar should say`,
    `what those are. Ours turned out to be holidays and a trip, which made the meeting total`,
    `roughly ten times too large until it was asked.`,
  ].join("\n");
}

export interface CalendarBreakdown {
  meetings: number;
  meetingHours: number;
  timeOff: number;
  timeOffHours: number;
  blocks: number;
  holds: number;
  /** Entries with no usable times, which are counted and never guessed at. */
  untimed: number;
}

export function breakdown(
  events: readonly CalendarEventShape[],
  conventions: CalendarConventions = {},
): CalendarBreakdown {
  const out: CalendarBreakdown = {
    meetings: 0,
    meetingHours: 0,
    timeOff: 0,
    timeOffHours: 0,
    blocks: 0,
    holds: 0,
    untimed: 0,
  };

  for (const e of events) {
    const hours = hoursBetween(e.startAt, e.endAt);
    if (hours === null) {
      out.untimed += 1;
      continue;
    }
    switch (classifyCalendarEvent(e, conventions)) {
      case "meeting":
        out.meetings += 1;
        out.meetingHours += hours;
        break;
      case "time-off":
        out.timeOff += 1;
        out.timeOffHours += hours;
        break;
      case "multi-day-block":
        out.blocks += 1;
        break;
      case "personal-hold":
        out.holds += 1;
        break;
    }
  }
  return out;
}

/** What a person reads, with the figure that would otherwise be wrong. */
export function describeBreakdown(b: CalendarBreakdown): string {
  const lines = [
    `${b.meetings} meeting(s), ${Math.round(b.meetingHours)} hour(s).`,
  ];
  if (b.timeOff > 0) {
    lines.push(
      `${b.timeOff} entr(ies) are somebody being away, ${Math.round(b.timeOffHours)} hour(s). Counted separately, because a holiday is not a meeting and including it would multiply the meeting figure several times over.`,
    );
  }
  if (b.blocks > 0) {
    lines.push(`${b.blocks} multi-day block(s): travel, events, conferences. Not meeting time.`);
  }
  if (b.holds > 0) {
    lines.push(`${b.holds} hold(s) somebody placed on their own time.`);
  }
  if (b.untimed > 0) {
    /* Counted, never guessed at: an entry with no times cannot contribute
       hours and pretending it contributes zero would be a different lie. */
    lines.push(`${b.untimed} entr(ies) had no usable times and are excluded from every figure above.`);
  }
  return lines.join("\n");
}
