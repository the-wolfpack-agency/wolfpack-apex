/**
 * A calendar is not a list of meetings.
 *
 * Every subject here is real, from our own calendar on 2026-08-31. Ninety-four
 * of 801 entries held ninety per cent of the hours and not one was a meeting.
 */
import {
  classifyCalendarEvent,
  breakdown,
  describeBreakdown,
  findConcentration,
  calibrationQuestion,
  NOT_A_MEETING_HOURS,
} from "../calendar-kinds";

const at = (h: number) => new Date(Date.UTC(2026, 7, 31, h)).toISOString();
const ev = (subject: string | null, hours = 1, attendeeCount = 3) => ({
  subject,
  startAt: at(9),
  endAt: new Date(Date.parse(at(9)) + hours * 3_600_000).toISOString(),
  attendeeCount,
});

describe("somebody being away", () => {
  /* The entry that made this necessary: "anyone whose meeting says OOO is
     just a vacation day". */
  it("recognizes the way people actually write it", () => {
    for (const s of ["Alicia OOO", "OOO", "Nick - PTO", "Vacation", "Annual leave", "Day off"]) {
      expect(classifyCalendarEvent(ev(s, 192))).toBe("time-off");
    }
  });

  /* A list long enough to catch every phrasing catches meetings about leave
     policy too. */
  it("does not mistake a meeting about leave for leave", () => {
    expect(classifyCalendarEvent(ev("Review the holiday policy draft"))).toBe("meeting");
    expect(classifyCalendarEvent(ev("Portfolio Optimization Overview"))).toBe("meeting");
  });

  it("recognizes time off however short it is", () => {
    expect(classifyCalendarEvent(ev("Alicia OOO", 4))).toBe("time-off");
  });
});

describe("long entries nobody labeled", () => {
  /* "F1 Las Vegas" and "Avryl Trip" say nothing about what they are and are
     only distinguishable as non-meetings by lasting 192 hours. Name alone
     misses them; shape alone misses "Alicia OOO". */
  it("treats a week-long entry as a block rather than a meeting", () => {
    expect(classifyCalendarEvent(ev("F1 Las Vegas", 192, 0))).toBe("multi-day-block");
    expect(classifyCalendarEvent(ev("Avryl Trip", 264, 0))).toBe("multi-day-block");
  });

  it("still calls a long workshop a meeting", () => {
    expect(classifyCalendarEvent(ev("BA101 facilitation day", 8))).toBe("meeting");
  });

  it("draws the line where an all-day entry sits", () => {
    expect(NOT_A_MEETING_HOURS).toBeGreaterThan(8);
    expect(NOT_A_MEETING_HOURS).toBeLessThan(24);
  });
});

describe("holds somebody puts on their own time", () => {
  it("recognizes a focus block", () => {
    expect(classifyCalendarEvent(ev("Focus time", 2, 0))).toBe("personal-hold");
    expect(classifyCalendarEvent(ev("Lunch", 1, 0))).toBe("personal-hold");
  });

  /* An entry with nobody invited is a note to self, however it is named. */
  it("treats a long unattended entry as a hold", () => {
    expect(classifyCalendarEvent(ev("Write the proposal", 5, 0))).toBe("personal-hold");
  });

  /* Checked after time off, so a one-person holiday is still a holiday. */
  it("does not turn a solo holiday into a hold", () => {
    expect(classifyCalendarEvent(ev("Vacation", 8, 0))).toBe("time-off");
  });
});

describe("the figure that would otherwise be wrong", () => {
  const week = [
    ev("Alicia OOO", 192, 8),
    ev("F1 Las Vegas", 192, 0),
    ev("Porsche weekly", 1),
    ev("BA101 review", 1.5),
  ];

  it("keeps a holiday out of the meeting hours", () => {
    const b = breakdown(week);
    expect(b.meetings).toBe(2);
    expect(Math.round(b.meetingHours)).toBe(3);
    expect(b.timeOff).toBe(1);
    expect(b.blocks).toBe(1);
  });

  /* Time off is its own answer to its own question, not noise to drop. */
  it("keeps time off rather than filtering it away", () => {
    expect(breakdown(week).timeOffHours).toBe(192);
    expect(describeBreakdown(breakdown(week))).toMatch(/somebody being away/i);
  });

  it("says why the separation matters, in the output", () => {
    expect(describeBreakdown(breakdown(week))).toMatch(/multiply the meeting figure/i);
  });

  /* An entry with no times cannot contribute hours, and pretending it
     contributes zero would be a different lie. */
  it("counts an untimed entry rather than scoring it zero", () => {
    const b = breakdown([{ subject: "No times", startAt: null, endAt: null }]);
    expect(b.untimed).toBe(1);
    expect(b.meetings).toBe(0);
    expect(describeBreakdown(b)).toMatch(/no usable times/i);
  });
});

/**
 * A meeting about time off is still a meeting.
 *
 * "Review the holiday policy draft" was classified as somebody's holiday,
 * which removes real meeting hours AND invents leave nobody took.
 */
describe("an appointment about a topic, not the topic itself", () => {
  it("keeps a meeting that merely mentions leave", () => {
    for (const s of [
      "Review the holiday policy draft",
      "PTO policy discussion",
      "Vacation planning sync",
      "1:1 - annual leave request",
    ]) {
      expect(classifyCalendarEvent(ev(s))).toBe("meeting");
    }
  });

  /* And does not let the rule swallow actual leave. */
  it("still recognizes leave with no meeting words in it", () => {
    for (const s of ["Alicia OOO", "PTO", "Vacation", "Nick - day off"]) {
      expect(classifyCalendarEvent(ev(s, 8))).toBe("time-off");
    }
  });
});

/**
 * A client will have a quirk of their own, and we will not know what it is.
 *
 * Ours was that "OOO" means a vacation day. It was invisible from the data:
 * the events were well formed, the arithmetic was correct, and the meeting
 * total was ten times too large. It was found because a person who knows the
 * calendar said so.
 *
 * A dealership marks floor duty and demo drives on the same calendar as
 * meetings. An agency blocks shoot days. Somebody prefixes placeholders with
 * "[HOLD]". None of that is guessable, so the deployment has to ask, and to
 * ask it has to notice.
 */
describe("preparing for a convention nobody has told us about", () => {
  const at = (h: number) => new Date(Date.UTC(2026, 7, 31, h)).toISOString();
  const long = (subject: string, hours: number) => ({
    subject,
    startAt: at(0),
    endAt: new Date(Date.parse(at(0)) + hours * 3_600_000).toISOString(),
    attendeeCount: 0,
  });

  /* The signature: a handful of entries holding most of the hours. This is
     what an unlabeled convention looks like from outside. */
  it("notices when a few entries hold most of the time", () => {
    const events = [long("Floor duty", 200), long("Floor duty", 200), ...Array.from({ length: 40 }, () => long("Standup", 0.5))];
    const c = findConcentration(events);
    expect(c.dominated).toBe(true);
    expect(c.examples[0]).toBe("Floor duty");
  });

  /* Two long workshops in a quiet week are not a convention. */
  it("does not cry convention on an ordinarily busy calendar", () => {
    const events = Array.from({ length: 40 }, (_, i) => long(`Meeting ${i}`, 1));
    expect(findConcentration(events).dominated).toBe(false);
  });

  /* It must not guess what the entries are: the whole lesson is that no
     amount of reading the data produces the answer. */
  it("asks rather than concludes", () => {
    const events = [long("Demo drive", 300), ...Array.from({ length: 30 }, () => long("Sync", 0.5))];
    const q = calibrationQuestion(findConcentration(events))!;
    expect(q).toMatch(/somebody who knows this calendar should say/i);
    expect(q).toContain("Demo drive");
    expect(q).not.toMatch(/is a|are holidays|is time off/i);
  });

  it("says nothing when there is nothing to ask about", () => {
    const events = Array.from({ length: 30 }, (_, i) => long(`Meeting ${i}`, 1));
    expect(calibrationQuestion(findConcentration(events))).toBeNull();
  });
});

describe("this organization's own vocabulary", () => {
  const at = (h: number) => new Date(Date.UTC(2026, 7, 31, h)).toISOString();
  const e = (subject: string, hours = 4) => ({
    subject,
    startAt: at(9),
    endAt: new Date(Date.parse(at(9)) + hours * 3_600_000).toISOString(),
    attendeeCount: 2,
  });

  /* Supplied per deployment rather than added to the built-in lists, because
     a pattern right for one client is wrong for the next: "demo" is a test
     drive at a dealership and a sales meeting everywhere else. */
  it("accepts a client's own way of saying somebody is away", () => {
    const conventions = { timeOff: [/(^|\W)rest day(\W|$)/i] };
    expect(classifyCalendarEvent(e("Rest day"), conventions)).toBe("time-off");
    /* And without it, the same entry is an ordinary meeting rather than a
       guess. */
    expect(classifyCalendarEvent(e("Rest day"))).toBe("meeting");
  });

  it("accepts a client's own non-meeting block", () => {
    const conventions = { notAMeeting: [/(^|\W)floor duty(\W|$)/i] };
    expect(classifyCalendarEvent(e("Floor duty"), conventions)).toBe("multi-day-block");
  });

  /* A meeting about the thing is still a meeting, even in a client's own
     vocabulary. */
  it("keeps a meeting that merely mentions the client's term", () => {
    const conventions = { timeOff: [/(^|\W)rest day(\W|$)/i] };
    expect(classifyCalendarEvent(e("Rest day policy review"), conventions)).toBe("meeting");
  });
});
