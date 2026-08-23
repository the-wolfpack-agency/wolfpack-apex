/**
 * Two weeks with identical totals and opposite outcomes.
 *
 * That is the whole argument for this file, so it is the first test.
 * Everything else guards against the ways a schedule report becomes
 * either wrong or preachy, both of which get it closed and ignored.
 */

export {};

import {
  analyseSchedule,
  renderSchedule,
  USABLE_BLOCK_MINUTES,
  type ScheduleEvent,
} from "../schedule-health";

/** Monday 2026-08-24 was a Monday. Local time throughout. */
function at(day: number, hour: number, minute = 0): string {
  const d = new Date(2026, 7, 24 + day, hour, minute, 0, 0);
  return d.toISOString();
}

function meeting(day: number, hour: number, lengthMin: number, subject = "Sync", attendees = 2): ScheduleEvent {
  const start = new Date(2026, 7, 24 + day, hour, 0, 0, 0);
  const end = new Date(start.getTime() + lengthMin * 60_000);
  return {
    subject,
    start: start.toISOString(),
    end: end.toISOString(),
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

  const a = analyseSchedule(clustered, { days: 7 });
  const b = analyseSchedule(scattered, { days: 7 });

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
    const r = analyseSchedule([allDay, meeting(0, 10, 60)], { days: 7 });
    expect(r.meetings).toBe(1);
    expect(r.meetingHours).toBe(1);
  });

  it("ignores a zero-length entry", () => {
    const r = analyseSchedule(
      [{ subject: "Reminder", start: at(0, 10), end: at(0, 10) }],
      { days: 7 },
    );
    expect(r.meetings).toBe(0);
  });
});

describe("free time is measured per day, not across the window", () => {
  it("does not offer Tuesday evening to Wednesday morning as a block", () => {
    /* The overnight gap is not fourteen hours of opportunity to
       concentrate. Two full days of meetings leaves nothing. */
    const solid = [0, 1].flatMap((d) => [meeting(d, 9, 480, "All day")]);
    const r = analyseSchedule(solid, { days: 7 });
    expect(r.usableBlocks).toBe(0);
    expect(r.freeHours).toBe(0);
  });

  it("counts the stretch before the first meeting and after the last", () => {
    const r = analyseSchedule([meeting(0, 12, 60)], { days: 7 });
    /* 9-12 is three hours, 1-5 is four. Both usable. */
    expect(r.usableBlocks).toBe(2);
    expect(r.usableHours).toBe(7);
  });

  it("treats overlapping meetings as one busy stretch, not two", () => {
    const overlapping = [meeting(0, 10, 120, "A"), meeting(0, 11, 120, "B")];
    const r = analyseSchedule(overlapping, { days: 7 });
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
    const r = analyseSchedule(backToBack, { days: 7 });
    expect(r.backToBackRuns).toBe(1);
    expect(r.longestRun).toBe(3);
  });

  it("does not count three meetings spread across a day", () => {
    const spread = [meeting(0, 9, 60, "A"), meeting(0, 12, 60, "B"), meeting(0, 15, 60, "C")];
    expect(analyseSchedule(spread, { days: 7 }).backToBackRuns).toBe(0);
  });

  it("does not join yesterday's last meeting to today's first", () => {
    const acrossNights = [
      meeting(0, 16, 60, "A"),
      meeting(1, 9, 60, "B"),
      meeting(2, 9, 60, "C"),
    ];
    expect(analyseSchedule(acrossNights, { days: 7 }).backToBackRuns).toBe(0);
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
    const r = analyseSchedule(events, { days: 7 });
    expect(r.heaviestRecurring).toMatchObject({ subject: "Standup", occurrences: 5, hoursPerWeek: 5 });
  });

  it("counts the cost to everyone invited, not only to one diary", () => {
    /* A weekly hour with twelve people in it is twelve hours of the
       organisation, and that is the number worth putting in front of
       whoever owns the meeting. */
    const r = analyseSchedule([meeting(0, 9, 60, "All hands", 12)], { days: 7 });
    expect(r.meetingHours).toBe(1);
    expect(r.attendeeHours).toBe(12);
  });

  it("does not call a single meeting a series", () => {
    expect(analyseSchedule([meeting(0, 9, 60, "One-off")], { days: 7 }).recurringHoursPerWeek).toBe(0);
  });
});

describe("ideal times of day", () => {
  it("names the least booked hours as the ones to defend", () => {
    /* Every day booked 9-11, nothing after. Afternoons are free. */
    const mornings = [0, 1, 2, 3, 4].map((d) => meeting(d, 9, 120, "Morning block"));
    const r = analyseSchedule(mornings, { days: 7 });
    expect(r.bestFocusHours.every((h) => h >= 11)).toBe(true);
    expect(r.busiestHours).toContain(9);
  });

  it("names the busiest hours as the cheapest place to add a meeting", () => {
    const afternoons = [0, 1, 2, 3, 4].map((d) => meeting(d, 15, 60, "Late"));
    const r = analyseSchedule(afternoons, { days: 7 });
    expect(r.busiestHours[0]).toBe(15);
  });

  it("reports a completely clear weekday as worth keeping", () => {
    const monThruThu = [0, 1, 2, 3].map((d) => meeting(d, 10, 60));
    /* Friday is index 5. */
    expect(analyseSchedule(monThruThu, { days: 7 }).clearDays).toContain(5);
  });
});

describe("how it reads", () => {
  it("leads with usable time rather than free time", () => {
    const fragmented = [0, 1, 2, 3, 4].flatMap((d) => [
      meeting(d, 9, 60), meeting(d, 11, 60), meeting(d, 13, 60), meeting(d, 15, 60),
    ]);
    const out = renderSchedule(analyseSchedule(fragmented, { days: 7 }));
    expect(out).toContain("actually usable");
    expect(out).toContain("too short to start anything");
  });

  it("never tells anyone they are doing badly", () => {
    /* The people who would benefit most are the ones who would close a
       tool that scolded them. */
    const brutal = [0, 1, 2, 3, 4].flatMap((d) =>
      [9, 10, 11, 13, 14, 15, 16].map((h) => meeting(d, h, 60, `M${h}`, 8)),
    );
    const out = renderSchedule(analyseSchedule(brutal, { days: 7 })).toLowerCase();
    for (const word of ["too many", "should not", "wasting", "poor", "bad ", "failing"]) {
      expect(out).not.toContain(word);
    }
  });

  it("says there is nothing to improve when the calendar is empty", () => {
    expect(renderSchedule(analyseSchedule([], { days: 7 }))).toContain("nothing here to improve");
  });

  it("still gives the best hours when nothing is stranded", () => {
    const out = renderSchedule(analyseSchedule([meeting(0, 9, 60)], { days: 7 }));
    expect(out).toContain("When to protect");
  });
});
