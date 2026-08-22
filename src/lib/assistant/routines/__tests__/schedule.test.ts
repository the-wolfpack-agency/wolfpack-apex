/**
 * When a routine is next due.
 *
 * Time arithmetic fails quietly and in public: a briefing that arrives an hour
 * after the meeting, in spring, for everybody at once. So the clock is an
 * argument here and every interesting case is pinned to a real instant.
 *
 * The daylight-saving tests are the reason this file exists.
 */
import { nextRun, parseSchedule, describeSchedule, isValidTimeZone } from "../schedule";

const NY = "America/New_York";
const LONDON = "Europe/London";

/** What a UTC instant reads as on a given wall clock. */
const localHour = (iso: string, tz: string) =>
  Number(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(
      new Date(iso),
    ) .replace("24", "0"),
  );

describe("daily", () => {
  it("gives today's slot when it has not passed yet", () => {
    /* 06:00 in New York, asking for 08:00. */
    const now = new Date("2026-03-10T11:00:00Z");
    const next = nextRun({ cadence: "daily", hour: 8, timeZone: NY }, now);
    expect(localHour(next.toISOString(), NY)).toBe(8);
    expect(next.toISOString().slice(0, 10)).toBe("2026-03-10");
  });

  it("rolls to tomorrow once it has passed", () => {
    /* 09:00 in New York, asking for 08:00. */
    const now = new Date("2026-03-10T14:00:00Z");
    const next = nextRun({ cadence: "daily", hour: 8, timeZone: NY }, now);
    expect(next.toISOString().slice(0, 10)).toBe("2026-03-11");
  });

  it("is STRICTLY after now, so a run does not fire twice on one tick", () => {
    /* Exactly 08:00 in New York. Returning the same instant would make the
       sweep pick it up again on the next pass, for an hour. */
    const now = new Date("2026-03-10T12:00:00Z");
    const next = nextRun({ cadence: "daily", hour: 8, timeZone: NY }, now);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect(next.toISOString().slice(0, 10)).toBe("2026-03-11");
  });
});

describe("the clocks changing", () => {
  it("still lands on 8am the day the US springs forward", () => {
    /* 2026-03-08 is the US change. A schedule stored as a UTC hour is an hour
       out from here until autumn, and nobody notices until a briefing arrives
       after the meeting it was for. */
    const now = new Date("2026-03-07T20:00:00Z");
    const next = nextRun({ cadence: "daily", hour: 8, timeZone: NY }, now);
    expect(localHour(next.toISOString(), NY)).toBe(8);
  });

  it("still lands on 8am the day the US falls back", () => {
    const now = new Date("2026-10-31T20:00:00Z");
    const next = nextRun({ cadence: "daily", hour: 8, timeZone: NY }, now);
    expect(localHour(next.toISOString(), NY)).toBe(8);
  });

  it("holds the local hour across a whole year of runs", () => {
    /* The strongest statement available: walk every day for a year and assert
       the person's wall clock never moves. */
    let cursor = new Date("2026-01-01T00:00:00Z");
    for (let i = 0; i < 365; i += 1) {
      const next = nextRun({ cadence: "daily", hour: 8, timeZone: NY }, cursor);
      expect(localHour(next.toISOString(), NY)).toBe(8);
      cursor = new Date(next.getTime() + 60_000);
    }
  });

  it("works the same in a zone that changes on different dates", () => {
    /* London and New York do not change on the same day. A single offset table
       gets one of them wrong for a fortnight every year. */
    const now = new Date("2026-03-25T09:00:00Z");
    const next = nextRun({ cadence: "daily", hour: 8, timeZone: LONDON }, now);
    expect(localHour(next.toISOString(), LONDON)).toBe(8);
  });
});

describe("weekdays", () => {
  const weekdayOf = (d: Date, tz: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d);

  it("skips Saturday and Sunday", () => {
    /* Friday evening in New York. */
    const now = new Date("2026-03-13T23:00:00Z");
    const next = nextRun({ cadence: "weekdays", hour: 8, timeZone: NY }, now);
    expect(weekdayOf(next, NY)).toBe("Mon");
  });

  it("uses the person's weekend, not UTC's", () => {
    /* Saturday 01:00 UTC is still Friday evening in New York, so the next
       weekday slot is Monday either way; the point is that the decision is
       made on their calendar. */
    const now = new Date("2026-03-14T01:00:00Z");
    const next = nextRun({ cadence: "weekdays", hour: 8, timeZone: NY }, now);
    expect(["Mon"]).toContain(weekdayOf(next, NY));
  });

  it("gives the next weekday when today is one and the hour has gone", () => {
    const now = new Date("2026-03-10T14:00:00Z"); // Tuesday 09:00 NY
    const next = nextRun({ cadence: "weekdays", hour: 8, timeZone: NY }, now);
    expect(weekdayOf(next, NY)).toBe("Wed");
  });
});

describe("weekly", () => {
  it("finds the named day", () => {
    const now = new Date("2026-03-10T14:00:00Z"); // Tuesday
    const next = nextRun({ cadence: "weekly", hour: 9, weekday: 1, timeZone: NY }, now);
    expect(new Intl.DateTimeFormat("en-US", { timeZone: NY, weekday: "short" }).format(next)).toBe("Mon");
    expect(localHour(next.toISOString(), NY)).toBe(9);
  });

  it("does not return today when today's slot has passed", () => {
    const now = new Date("2026-03-09T15:00:00Z"); // Monday 11:00 NY
    const next = nextRun({ cadence: "weekly", hour: 9, weekday: 1, timeZone: NY }, now);
    expect(next.getTime() - now.getTime()).toBeGreaterThan(6 * 86_400_000);
  });
});

describe("reading a schedule out of a sentence", () => {
  it.each([
    ["every weekday at 8am", "weekdays", 8],
    ["every day at 7", "daily", 7],
    ["daily at 9am", "daily", 9],
    ["every monday at 9am", "weekly", 9],
    ["every friday at 4pm", "weekly", 16],
  ])("reads %p", (text, cadence, hour) => {
    const s = parseSchedule(text, NY);
    expect(s).toMatchObject({ cadence, hour });
  });

  it("refuses a sentence with no time, rather than choosing one", () => {
    /* A schedule invented from an ambiguous sentence fires at 3am forever and
       nobody connects it back to what they typed. */
    expect(parseSchedule("every weekday", NY)).toBeNull();
  });

  it("refuses a sentence with no cadence", () => {
    expect(parseSchedule("at 8am", NY)).toBeNull();
  });

  it("refuses an ambiguous early hour with no am or pm", () => {
    /* "at 6" is far more likely to be an evening than a pre-dawn start, and
       guessing either way schedules something nobody asked for. */
    expect(parseSchedule("every day at 6", NY)).toBeNull();
    expect(parseSchedule("every day at 6am", NY)).toMatchObject({ hour: 6 });
  });

  it("reads midnight and midday correctly", () => {
    expect(parseSchedule("every day at 12am", NY)).toMatchObject({ hour: 0 });
    expect(parseSchedule("every day at 12pm", NY)).toMatchObject({ hour: 12 });
  });

  it("refuses an impossible hour", () => {
    expect(parseSchedule("every day at 47", NY)).toBeNull();
  });
});

describe("saying it back", () => {
  it.each([
    [{ cadence: "daily" as const, hour: 8, timeZone: NY }, "every day at 8am"],
    [{ cadence: "weekdays" as const, hour: 17, timeZone: NY }, "every weekday at 5pm"],
    [{ cadence: "weekly" as const, hour: 9, weekday: 1, timeZone: NY }, "every Monday at 9am"],
    [{ cadence: "daily" as const, hour: 0, timeZone: NY }, "every day at midnight"],
    [{ cadence: "daily" as const, hour: 12, timeZone: NY }, "every day at midday"],
  ])("describes %o", (schedule, expected) => {
    expect(describeSchedule(schedule)).toBe(expected);
  });
});

describe("zones", () => {
  it("accepts a real one and refuses nonsense before it can fail at 6am", () => {
    expect(isValidTimeZone(NY)).toBe(true);
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
  });
});
