/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  computeHistoricalInsights,
  rangeBoundsFor,
} from "@/lib/calendar/historical-insights";

const WEEK_REF = Date.parse("2026-04-21T12:00:00Z"); // Tuesday
const MS_HOUR = 3600_000;

function ev(startIso: string, durationHours: number, attendees: string[] = []): any {
  const startMs = Date.parse(startIso);
  return {
    id: `e-${startIso}`,
    subject: "x",
    start: startIso,
    end: new Date(startMs + durationHours * MS_HOUR).toISOString(),
    location: "",
    attendees,
    attendeeEmails: [],
    isOnlineMeeting: false,
  };
}

describe("rangeBoundsFor", () => {
  test("week bounds cover Sunday 00:00 → Saturday 23:59 UTC", () => {
    const { startMs, endMs } = rangeBoundsFor("week", WEEK_REF);
    const start = new Date(startMs);
    const end = new Date(endMs);
    expect(start.getUTCDay()).toBe(0); // Sunday
    expect(start.getUTCHours()).toBe(0);
    expect(end.getUTCDay()).toBe(6); // Saturday
    expect(endMs - startMs).toBeGreaterThan(6 * 24 * MS_HOUR);
  });

  test("month bounds cover first → last day of the reference month", () => {
    const { startMs, endMs } = rangeBoundsFor("month", WEEK_REF);
    expect(new Date(startMs).getUTCDate()).toBe(1);
    expect(new Date(endMs).getUTCMonth()).toBe(new Date(startMs).getUTCMonth());
  });

  test("year bounds cover Jan 1 → Dec 31 UTC", () => {
    const { startMs, endMs } = rangeBoundsFor("year", WEEK_REF);
    expect(new Date(startMs).getUTCMonth()).toBe(0);
    expect(new Date(startMs).getUTCDate()).toBe(1);
    expect(new Date(endMs).getUTCMonth()).toBe(11);
  });
});

describe("computeHistoricalInsights", () => {
  test("filters events outside the range", () => {
    const events = [
      ev("2026-01-01T10:00:00Z", 1), // outside
      ev("2026-04-21T10:00:00Z", 1), // inside
    ];
    const bounds = rangeBoundsFor("week", WEEK_REF);
    const out = computeHistoricalInsights({
      events,
      rangeStartMs: bounds.startMs,
      rangeEndMs: bounds.endMs,
    });
    expect(out.meetingCount).toBe(1);
    expect(out.totalMeetingHours).toBe(1);
  });

  test("counts solo blocks (zero attendees) separately", () => {
    const bounds = rangeBoundsFor("week", WEEK_REF);
    const out = computeHistoricalInsights({
      events: [
        ev("2026-04-21T10:00:00Z", 1, []),
        ev("2026-04-21T13:00:00Z", 1, ["Alice"]),
      ],
      rangeStartMs: bounds.startMs,
      rangeEndMs: bounds.endMs,
    });
    expect(out.soloBlockCount).toBe(1);
    expect(out.meetingCount).toBe(2);
  });

  test("detects back-to-back meetings (<=5 min apart)", () => {
    const bounds = rangeBoundsFor("week", WEEK_REF);
    const out = computeHistoricalInsights({
      events: [
        ev("2026-04-21T10:00:00Z", 1, ["A"]),
        ev("2026-04-21T11:03:00Z", 0.5, ["B"]), // 3-min gap
        ev("2026-04-21T12:30:00Z", 0.5, ["C"]), // 27-min gap, NOT back-to-back
      ],
      rangeStartMs: bounds.startMs,
      rangeEndMs: bounds.endMs,
    });
    expect(out.backToBackPct).toBe(33); // 1 of 3 = 33%
  });

  test("buckets meetings into weekly series sorted oldest-first", () => {
    const bounds = rangeBoundsFor("month", WEEK_REF);
    const out = computeHistoricalInsights({
      events: [
        ev("2026-04-07T10:00:00Z", 2, ["A"]), // week of Apr 5
        ev("2026-04-14T10:00:00Z", 1, ["A"]), // week of Apr 12
        ev("2026-04-21T10:00:00Z", 1, ["A"]), // week of Apr 19
      ],
      rangeStartMs: bounds.startMs,
      rangeEndMs: bounds.endMs,
    });
    expect(out.weeklySeries).toHaveLength(3);
    expect(out.weeklySeries[0].hours).toBeLessThanOrEqual(out.weeklySeries[2].hours + 5);
    // sorted ascending
    expect(out.weeklySeries[0].weekStartIso < out.weeklySeries[1].weekStartIso).toBe(true);
  });

  test("top attendees preserve original casing, dedupe case-insensitively", () => {
    const bounds = rangeBoundsFor("year", WEEK_REF);
    const out = computeHistoricalInsights({
      events: [
        ev("2026-02-10T10:00:00Z", 1, ["Nick Hoxsie"]),
        ev("2026-03-10T10:00:00Z", 1, ["nick hoxsie"]),
        ev("2026-04-10T10:00:00Z", 1, ["Jorge"]),
      ],
      rangeStartMs: bounds.startMs,
      rangeEndMs: bounds.endMs,
    });
    expect(out.topAttendees[0].display).toBe("Nick Hoxsie");
    expect(out.topAttendees[0].count).toBe(2);
  });

  test("averageDurationMinutes is null when no meetings", () => {
    const out = computeHistoricalInsights({
      events: [],
      rangeStartMs: 0,
      rangeEndMs: 1,
    });
    expect(out.averageDurationMinutes).toBeNull();
    expect(out.meetingCount).toBe(0);
  });

  test("day-of-week distribution tallies per UTC weekday", () => {
    const bounds = rangeBoundsFor("year", WEEK_REF);
    const out = computeHistoricalInsights({
      events: [
        ev("2026-04-20T10:00:00Z", 1), // Mon
        ev("2026-04-20T15:00:00Z", 1), // Mon
        ev("2026-04-22T10:00:00Z", 1), // Wed
      ],
      rangeStartMs: bounds.startMs,
      rangeEndMs: bounds.endMs,
    });
    expect(out.dayOfWeekDistribution[1]).toBe(2); // Mon
    expect(out.dayOfWeekDistribution[3]).toBe(1); // Wed
  });
});
