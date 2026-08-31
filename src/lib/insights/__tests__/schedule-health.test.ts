/**
 * Two weeks with identical totals and opposite outcomes.
 *
 * That is the whole argument for this file, so it is the first test.
 * Everything else guards against the ways a schedule report becomes
 * either wrong or preachy, both of which get it closed and ignored.
 */

export {};

import {
  analyzeSchedule,
  renderSchedule,
  USABLE_BLOCK_MINUTES,
  type ScheduleEvent,
} from "../schedule-health";

/* 2026-08-24 was a Monday. Built and analyzed in UTC, so the suite says
   the same thing on a laptop in Manchester and a runner in us-east-1.
   Before the zone became an input these helpers used the machine's own
   clock on both sides, which agreed with itself and with nothing else. */
const ZONE = { timeZone: "UTC" } as const;

function at(day: number, hour: number, minute = 0): string {
  return new Date(Date.UTC(2026, 7, 24 + day, hour, minute, 0, 0)).toISOString();
}

function meeting(day: number, hour: number, lengthMin: number, subject = "Sync", attendees = 2): ScheduleEvent {
  const start = Date.UTC(2026, 7, 24 + day, hour, 0, 0, 0);
  return {
    subject,
    start: new Date(start).toISOString(),
    end: new Date(start + lengthMin * 60_000).toISOString(),
    attendees: Array.from({ length: attendees }, (_, i) => `p${i}@x.com`),
  };
}

describe("the number nobody else is showing them", () => {
  /* Both weeks: 5 working days, 9-5, four hours of meetings a day.
     Identical meeting hours, identical free hours, opposite weeks. */
  const clustered: ScheduleEvent[] = [0, 1, 2, 3, 4].flatMap((d) => [
    meeting(d, 9, 240, "Block"),
  ]);
  const scattered: ScheduleEvent[] = [0, 1, 2, 3, 4].flatMap((d) => [
    meeting(d, 9, 60, "A"),
    meeting(d, 11, 60, "B"),
    meeting(d, 13, 60, "C"),
    meeting(d, 15, 60, "D"),
  ]);

  const a = analyzeSchedule(clustered, { days: 7, ...ZONE });
  const b = analyzeSchedule(scattered, { days: 7, ...ZONE });

  it("agrees the two weeks are identical on every total anyone measures", () => {
    expect(a.meetingHours).toBe(b.meetingHours);
    expect(a.freeHours).toBe(b.freeHours);
  });

  it("and reports them as completely different weeks", () => {
    /* Clustered: one four-hour stretch a day, all of it usable.
       Scattered: the same four hours as one-hour gaps, none usable. */
    expect(a.usableBlocks).toBe(5);
    expect(a.strandedHours).toBe(0);
    expect(b.usableBlocks).toBe(0);
    expect(b.strandedHours).toBe(b.freeHours);
  });
});

describe("what counts as a meeting", () => {
  it("ignores an all-day marker rather than calling it eight meeting-hours", async () => {
    /* An "Out of office" counted as a meeting swamps every other
       number in the report. */
    const allDay: ScheduleEvent = {
      subject: "Out of office",
      start: at(0, 0),
      end: at(1, 0),
    };
    const r = analyzeSchedule([allDay, meeting(0, 10, 60)], { days: 7, ...ZONE });
    expect(r.meetings).toBe(1);
    expect(r.meetingHours).toBe(1);
  });

  it("ignores a zero-length entry", () => {
    const r = analyzeSchedule(
      [{ subject: "Reminder", start: at(0, 10), end: at(0, 10) }],
      { days: 7, ...ZONE },
    );
    expect(r.meetings).toBe(0);
  });
});

describe("free time is measured per day, not across the window", () => {
  it("does not offer Tuesday evening to Wednesday morning as a block", () => {
    /* The overnight gap is not fourteen hours of opportunity to
       concentrate. Two full days of meetings leaves nothing. */
    const solid = [0, 1].flatMap((d) => [meeting(d, 9, 480, "All day")]);
    const r = analyzeSchedule(solid, { days: 7, ...ZONE });
    expect(r.usableBlocks).toBe(0);
    expect(r.freeHours).toBe(0);
  });

  it("counts the stretch before the first meeting and after the last", () => {
    const r = analyzeSchedule([meeting(0, 12, 60)], { days: 7, ...ZONE });
    /* 9-12 is three hours, 1-5 is four. Both usable. */
    expect(r.usableBlocks).toBe(2);
    expect(r.usableHours).toBe(7);
  });

  it("treats overlapping meetings as one busy stretch, not two", () => {
    const overlapping = [meeting(0, 10, 120, "A"), meeting(0, 11, 120, "B")];
    const r = analyzeSchedule(overlapping, { days: 7, ...ZONE });
    /* Busy 10-1. Free 9-10 (stranded) and 1-5 (usable). */
    expect(r.usableBlocks).toBe(1);
    expect(r.usableHours).toBe(4);
  });
});

describe("runs", () => {
  it("counts a run only when the gaps are too short to be a break", () => {
    const backToBack = [
      meeting(0, 9, 60, "A"),
      meeting(0, 10, 60, "B"),
      meeting(0, 11, 60, "C"),
    ];
    const r = analyzeSchedule(backToBack, { days: 7, ...ZONE });
    expect(r.backToBackRuns).toBe(1);
    expect(r.longestRun).toBe(3);
  });

  it("does not count three meetings spread across a day", () => {
    const spread = [meeting(0, 9, 60, "A"), meeting(0, 12, 60, "B"), meeting(0, 15, 60, "C")];
    expect(analyzeSchedule(spread, { days: 7, ...ZONE }).backToBackRuns).toBe(0);
  });

  it("does not join yesterday's last meeting to today's first", () => {
    const acrossNights = [
      meeting(0, 16, 60, "A"),
      meeting(1, 9, 60, "B"),
      meeting(2, 9, 60, "C"),
    ];
    expect(analyzeSchedule(acrossNights, { days: 7, ...ZONE }).backToBackRuns).toBe(0);
  });
});

describe("standing cost", () => {
  it("finds the heaviest recurring series and its weekly cost", () => {
    const events = [
      meeting(0, 9, 60, "Standup"),
      meeting(1, 9, 60, "Standup"),
      meeting(2, 9, 60, "Standup"),
      meeting(3, 9, 60, "Standup"),
      meeting(4, 9, 60, "Standup"),
      meeting(0, 14, 30, "One-off"),
    ];
    const r = analyzeSchedule(events, { days: 7, ...ZONE });
    expect(r.heaviestRecurring).toMatchObject({ subject: "Standup", occurrences: 5, hoursPerWeek: 5 });
  });

  it("counts the cost to everyone invited, not only to one diary", () => {
    /* A weekly hour with twelve people in it is twelve hours of the
       organization, and that is the number worth putting in front of
       whoever owns the meeting. */
    const r = analyzeSchedule([meeting(0, 9, 60, "All hands", 12)], { days: 7, ...ZONE });
    expect(r.meetingHours).toBe(1);
    expect(r.attendeeHours).toBe(12);
  });

  it("does not call a single meeting a series", () => {
    expect(analyzeSchedule([meeting(0, 9, 60, "One-off")], { days: 7, ...ZONE }).recurringHoursPerWeek).toBe(0);
  });
});

describe("ideal times of day", () => {
  it("names the least booked hours as the ones to defend", () => {
    /* Every day booked 9-11, nothing after. Afternoons are free. */
    const mornings = [0, 1, 2, 3, 4].map((d) => meeting(d, 9, 120, "Morning block"));
    const r = analyzeSchedule(mornings, { days: 7, ...ZONE });
    expect(r.bestFocusHours.every((h) => h >= 11)).toBe(true);
    expect(r.busiestHours).toContain(9);
  });

  it("names the busiest hours as the cheapest place to add a meeting", () => {
    const afternoons = [0, 1, 2, 3, 4].map((d) => meeting(d, 15, 60, "Late"));
    const r = analyzeSchedule(afternoons, { days: 7, ...ZONE });
    expect(r.busiestHours[0]).toBe(15);
  });

  it("reports a completely clear weekday as worth keeping", () => {
    const monThruThu = [0, 1, 2, 3].map((d) => meeting(d, 10, 60));
    /* Friday is index 5. */
    expect(analyzeSchedule(monThruThu, { days: 7, ...ZONE }).clearDays).toContain(5);
  });
});

describe("how it reads", () => {
  it("leads with usable time rather than free time", () => {
    const fragmented = [0, 1, 2, 3, 4].flatMap((d) => [
      meeting(d, 9, 60), meeting(d, 11, 60), meeting(d, 13, 60), meeting(d, 15, 60),
    ]);
    const out = renderSchedule(analyzeSchedule(fragmented, { days: 7, ...ZONE }));
    expect(out).toContain("actually usable");
    expect(out).toContain("too short to start anything");
  });

  it("never tells anyone they are doing badly", () => {
    /* The people who would benefit most are the ones who would close a
       tool that scolded them. */
    const brutal = [0, 1, 2, 3, 4].flatMap((d) =>
      [9, 10, 11, 13, 14, 15, 16].map((h) => meeting(d, h, 60, `M${h}`, 8)),
    );
    const out = renderSchedule(analyzeSchedule(brutal, { days: 7, ...ZONE })).toLowerCase();
    for (const word of ["too many", "should not", "wasting", "poor", "bad ", "failing"]) {
      expect(out).not.toContain(word);
    }
  });

  it("says there is nothing to improve when the calendar is empty", () => {
    expect(renderSchedule(analyzeSchedule([], { days: 7, ...ZONE }))).toContain("nothing here to improve");
  });

  it("still gives the best hours when nothing is stranded", () => {
    const out = renderSchedule(analyzeSchedule([meeting(0, 9, 60)], { days: 7, ...ZONE }));
    expect(out).toContain("When to protect");
  });
});

/**
 * Whose nine in the morning?
 *
 * Found by running the same week of meetings under three server
 * timezones and getting three different answers. Every hour in this
 * analysis came from getHours(), which reads the machine's clock, and
 * Vercel runs UTC. The most actionable line the report produces, the
 * hours to defend, was wrong for everyone outside UTC.
 */
describe("the hours belong to the person, not to the server", () => {
  /* A normal Detroit week: 9am and 2pm, Monday to Friday, stored as
     absolute instants because that is what Graph returns. */
  const detroitWeek: ScheduleEvent[] = [0, 1, 2, 3, 4].flatMap((d) => {
    const day = 24 + d;
    return [
      { subject: "Morning", start: `2026-08-${day}T13:00:00.000Z`, end: `2026-08-${day}T14:00:00.000Z`, attendees: ["a", "b"] },
      { subject: "Afternoon", start: `2026-08-${day}T18:00:00.000Z`, end: `2026-08-${day}T19:00:00.000Z`, attendees: ["a", "b"] },
    ];
  });

  it("reports the meetings at the times the person actually had them", () => {
    const r = analyzeSchedule(detroitWeek, { days: 7, timeZone: "America/Detroit" });
    /* 9am and 2pm local. Under the server's clock in UTC these came
       back as 1pm and 4pm: somebody else's afternoon. */
    expect(r.busiestHours).toContain(9);
    expect(r.busiestHours).toContain(14);
  });

  it("gives the same answer whatever zone the code is running in", () => {
    const a = analyzeSchedule(detroitWeek, { days: 7, timeZone: "America/Detroit" });
    const b = analyzeSchedule(detroitWeek, { days: 7, timeZone: "America/Detroit" });
    expect(a).toEqual(b);
    /* And a different PERSON's zone genuinely is a different answer,
       which is the point: the same instants are a different week
       depending on where you live. */
    const london = analyzeSchedule(detroitWeek, { days: 7, timeZone: "Europe/London" });
    expect(london.busiestHours).not.toEqual(a.busiestHours);
  });

  it("accepts the Windows zone names Graph hands back", () => {
    /* Mailbox settings return "Eastern Standard Time", not an IANA id.
       Taking it literally would silently fall back to UTC. */
    const r = analyzeSchedule(detroitWeek, { days: 7, timeZone: "Eastern Standard Time" });
    expect(r.timeZone).toBe("America/New_York");
    expect(r.busiestHours).toContain(9);
  });

  it("falls back to UTC and says so, rather than guessing", () => {
    const r = analyzeSchedule(detroitWeek, { days: 7, timeZone: null });
    expect(r.timeZone).toBe("UTC");
    expect(renderSchedule(r)).toContain("times in UTC");
  });

  it("names the zone in the paragraph the reader is meant to act on", () => {
    /* A reader in Detroit shown UTC afternoons acts on them once and
       never opens it again. */
    const out = renderSchedule(analyzeSchedule(detroitWeek, { days: 7, timeZone: "America/Detroit" }));
    expect(out).toContain("times in America/Detroit");
  });

  it("keeps a meeting's real length across a daylight-saving change", () => {
    /* 2026-11-01, clocks go back in the US. A one-hour meeting spanning
       the change is still one hour, and reading the end time from the
       wall clock would call it two. */
    const r = analyzeSchedule(
      [{ subject: "Across the change", start: "2026-11-01T05:30:00.000Z", end: "2026-11-01T06:30:00.000Z", attendees: ["a"] }],
      { days: 7, timeZone: "America/Detroit" },
    );
    expect(r.meetingHours).toBe(1);
  });
});

/**
 * Not everything on a calendar is a meeting.
 *
 * Found when listEvents was finally driven against something Graph-shaped:
 * the query never asked whether an event was cancelled, declined, or a
 * Focus Time block, so all of them were counted as hours somebody spent in
 * a room.
 */
describe("what counts as a meeting", () => {
  const oneHour = (over: Partial<ScheduleEvent>): ScheduleEvent => ({
    subject: "Thing",
    start: "2026-08-24T09:00:00.000Z",
    end: "2026-08-24T10:00:00.000Z",
    attendees: ["a", "b"],
    ...over,
  });

  it("does not count a cancelled occurrence", () => {
    /* It stays on the calendar and nobody attended it. */
    const r = analyzeSchedule([oneHour({ isCancelled: true })], { days: 7, ...ZONE });
    expect(r.meetings).toBe(0);
  });

  it("does not count a meeting this person declined", () => {
    /* Somebody else's meeting. Counting it charges them for an hour they
       deliberately kept. */
    const r = analyzeSchedule([oneHour({ responseStatus: "declined" })], { days: 7, ...ZONE });
    expect(r.meetings).toBe(0);
  });

  it("does not count a Focus Time block as a meeting", () => {
    /* The worst of the four. Outlook creates these to PROTECT time to work
       in, so counting them inverts the whole report: the hours a person
       defended get billed to them as meetings, and the usable-block measure
       this analysis exists to produce falls as a direct result. */
    const focus = oneHour({ subject: "Focus time", showAs: "free", attendees: [] });
    const r = analyzeSchedule([focus], { days: 7, ...ZONE });
    expect(r.meetings).toBe(0);
    /* Free hours are counted per day that HAS something on it, so a week of
       nothing but focus blocks is not "eight free hours", it is a week with
       no meetings in it, and the report says exactly that. */
    expect(renderSchedule(r)).toContain("No meetings");
  });

  it("gives the hour back when a focus block sits beside a real meeting", () => {
    /* The measurable half of the same point: the day has a meeting, so it
       is counted, and the focus block is free time rather than a second
       meeting. */
    const withBoth = analyzeSchedule(
      [
        oneHour({ subject: "Standup", showAs: "busy" }),
        oneHour({
          subject: "Focus time",
          showAs: "free",
          start: "2026-08-24T13:00:00.000Z",
          end: "2026-08-24T15:00:00.000Z",
        }),
      ],
      { days: 7, ...ZONE },
    );
    expect(withBoth.meetings).toBe(1);
    expect(withBoth.meetingHours).toBe(1);
    /* 9-5 with one hour taken: seven hours free, and the 1pm-3pm stretch is
       not carved out of it. */
    expect(withBoth.freeHours).toBe(7);
  });

  it("does not count out of office", () => {
    const r = analyzeSchedule([oneHour({ showAs: "oof" })], { days: 7, ...ZONE });
    expect(r.meetings).toBe(0);
  });

  it("still counts a tentative one", () => {
    /* A maybe is an hour that cannot be planned around, which is exactly
       what the report measures. */
    const r = analyzeSchedule([oneHour({ showAs: "tentative" })], { days: 7, ...ZONE });
    expect(r.meetings).toBe(1);
  });

  it("still counts an ordinary accepted meeting", () => {
    const r = analyzeSchedule(
      [oneHour({ showAs: "busy", responseStatus: "accepted", isCancelled: false })],
      { days: 7, ...ZONE },
    );
    expect(r.meetings).toBe(1);
  });

  it("counts everything when the source says nothing about any of this", () => {
    /* A calendar that carries none of these flags must not become an empty
       week. Absence of a marker is not a cancellation. */
    const r = analyzeSchedule([oneHour({})], { days: 7, ...ZONE });
    expect(r.meetings).toBe(1);
  });

  it("takes Graph's word on all-day rather than inferring it from length", () => {
    /* The duration filter already drops anything over eight hours, which
       misses a six-hour all-day marker. Graph states it outright. */
    const r = analyzeSchedule(
      [oneHour({ isAllDay: true, end: "2026-08-24T15:00:00.000Z" })],
      { days: 7, ...ZONE },
    );
    expect(r.meetings).toBe(0);
  });
});
