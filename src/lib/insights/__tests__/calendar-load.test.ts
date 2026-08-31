/**
 * How a week is actually spent.
 *
 * The capability was missing rather than misrouted: learning/calendar-signals
 * reads a log of calendar writes INSTINCT made, which is a different question,
 * and the synced calendar it needed was empty until the sync was scheduled.
 */
import { summariseLoad, longestRun, describeLoad, type LoadEvent } from "../calendar-load";

const day = (h: number, m = 0) => new Date(Date.UTC(2026, 7, 31, h, m)).toISOString();
const ev = (
  person: string,
  subject: string,
  startHour: number,
  hours: number,
  attendeeCount = 3,
): LoadEvent => ({
  person,
  subject,
  startAt: day(startHour),
  endAt: new Date(Date.parse(day(startHour)) + hours * 3_600_000).toISOString(),
  attendeeCount,
});

describe("what counts as load", () => {
  /* THE MISTAKE THIS IS WRITTEN TO AVOID. On our own calendar, time away and
     trips held ninety per cent of the hours. */
  it("keeps a holiday out of the meeting hours", () => {
    const load = summariseLoad(
      [ev("alicia", "Alicia OOO", 0, 192, 8), ev("alicia", "Porsche weekly", 9, 1)],
      7,
    );
    const alicia = load.people[0];
    expect(alicia.meetings).toBe(1);
    expect(alicia.meetingHours).toBe(1);
  });

  /* Not discarded: who is off and when answers its own question. */
  it("reports the time away in days somebody would say out loud", () => {
    const load = summariseLoad([ev("alicia", "Alicia OOO", 0, 16, 0)], 7);
    expect(load.people[0].timeOffDays).toBe(2);
  });

  it("leaves trips and holds out of both figures", () => {
    const load = summariseLoad(
      [ev("max", "F1 Las Vegas", 0, 192, 0), ev("max", "Focus time", 9, 2, 0)],
      7,
    );
    expect(load.people[0]).toMatchObject({ meetings: 0, meetingHours: 0, timeOffDays: 0 });
  });

  /* A meeting with nobody else invited is a note to self, and separating them
     is what makes a load figure credible to the person it describes. */
  it("counts meetings with nobody else invited separately", () => {
    const load = summariseLoad(
      [ev("nick", "Draft the SOW", 9, 1, 0), ev("nick", "Porsche weekly", 11, 1, 4)],
      7,
    );
    expect(load.people[0]).toMatchObject({ meetings: 2, withOthers: 1 });
  });
});

describe("the longest run of meetings", () => {
  /* "Four in a row" is a thing somebody recognises about their own Tuesday.
     "63% fragmentation" is not. */
  it("counts meetings that touch", () => {
    expect(
      longestRun([
        { startAt: day(9), endAt: day(10) },
        { startAt: day(10), endAt: day(11) },
        { startAt: day(11), endAt: day(12) },
      ]),
    ).toBe(3);
  });

  /* Five minutes is not a break, and a gap breaks the run. */
  it("breaks the run on a gap", () => {
    expect(
      longestRun([
        { startAt: day(9), endAt: day(10) },
        { startAt: day(10, 5), endAt: day(11) },
      ]),
    ).toBe(1);
  });

  it("handles an overlapping pair without double counting", () => {
    expect(
      longestRun([
        { startAt: day(9), endAt: day(11) },
        { startAt: day(10), endAt: day(12) },
      ]),
    ).toBe(2);
  });

  it("is zero when there is nothing", () => {
    expect(longestRun([])).toBe(0);
  });
});

describe("what it refuses to imply", () => {
  /* An empty result and a broken sync look identical as a number and mean
     opposite things. */
  it("does not let an empty calendar read as a quiet week", () => {
    expect(describeLoad(summariseLoad([], 7))).toMatch(/not the same as a quiet one/i);
  });

  /* Counted, never scored as zero: an entry with no times cannot contribute
     hours and pretending it contributes none is a different lie. */
  it("counts entries it could not use", () => {
    const load = summariseLoad(
      [{ person: "nick", subject: "No times", startAt: null, endAt: null }],
      7,
    );
    expect(load.unusable).toBe(1);
    /* And says so instead of the quiet-week sentence, which would send
       somebody to check the sync when the problem is the entries. */
    expect(describeLoad(load)).toMatch(/no usable times/i);
    expect(describeLoad(load)).not.toMatch(/not the same as a quiet one/i);
  });

  it("says what was excluded, next to the numbers", () => {
    const text = describeLoad(summariseLoad([ev("nick", "Porsche weekly", 9, 1)], 7));
    expect(text).toMatch(/excluded from the meeting figures/i);
    expect(text).toMatch(/tenfold/i);
  });
});

/**
 * A team invites everybody to its holidays.
 *
 * On our own calendar every OOO entry appeared on all six calendars, so the
 * first version gave all six people an identical 12.6 days away: everyone's
 * holidays, counted six times. It looked plausible and was wrong for everyone.
 */
describe("whose time off it actually is", () => {
  const ooo = (person: string, organiser: string) => ({
    person,
    organiser,
    subject: "Alicia OOO",
    startAt: day(0),
    endAt: new Date(Date.parse(day(0)) + 16 * 3_600_000).toISOString(),
    attendeeCount: 6,
  });

  it("credits the holiday to the person who is away", () => {
    const load = summariseLoad([ooo("alicia", "alicia"), ooo("nick", "alicia")], 7);
    const alicia = load.people.find((p) => p.person === "alicia")!;
    const nick = load.people.find((p) => p.person === "nick")!;
    expect(alicia.timeOffDays).toBe(2);
    expect(nick.timeOffDays).toBe(0);
  });

  /* Somebody else's holiday on your calendar is not your meeting either. */
  it("does not turn a colleague's holiday into a meeting", () => {
    const load = summariseLoad([ooo("nick", "alicia")], 7);
    expect(load.people[0]).toMatchObject({ meetings: 0, meetingHours: 0, timeOffDays: 0 });
  });

  /* A meeting needs no such rule: an attendee really did spend that hour. */
  it("still counts a meeting on every attendee's calendar", () => {
    const meeting = (person: string) => ({
      ...ev(person, "Porsche weekly", 9, 1),
      organiser: "nick",
    });
    const load = summariseLoad([meeting("nick"), meeting("alicia")], 7);
    expect(load.people.map((p) => p.meetingHours)).toEqual([1, 1]);
  });

  /* An entry with no organiser recorded is the person's own, which is the
     safe reading: a calendar with no invitation is a note to self. */
  it("treats an unorganised entry as the person's own", () => {
    const load = summariseLoad(
      [{ person: "nick", subject: "Vacation", startAt: day(0), endAt: day(8), attendeeCount: 0 }],
      7,
    );
    expect(load.people[0].timeOffDays).toBe(1);
  });
});
