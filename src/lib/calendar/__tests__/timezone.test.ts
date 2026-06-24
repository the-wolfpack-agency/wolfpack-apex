/**
 * Unit tests for the Graph timezone helpers. These pin the exact UTC instants,
 * since an off-by-one-day or off-by-hours error here is precisely the CEO bug.
 */

import {
  normalizeGraphDateTime,
  resolveIanaZone,
  zonedWallClockToUtcMs,
  dayWindowInTimeZone,
  isSameLocalDay,
} from "@/lib/calendar/timezone";

describe("resolveIanaZone", () => {
  it("maps UTC variants", () => {
    expect(resolveIanaZone("UTC")).toBe("UTC");
    expect(resolveIanaZone("Coordinated Universal Time")).toBe("UTC");
  });
  it("maps common Windows zone names to IANA", () => {
    expect(resolveIanaZone("Eastern Standard Time")).toBe("America/New_York");
    expect(resolveIanaZone("Pacific Standard Time")).toBe("America/Los_Angeles");
    expect(resolveIanaZone("GMT Standard Time")).toBe("Europe/London");
  });
  it("passes through IANA ids", () => {
    expect(resolveIanaZone("America/Chicago")).toBe("America/Chicago");
  });
  it("returns null for unknown or empty", () => {
    expect(resolveIanaZone("Narnia Standard Time")).toBeNull();
    expect(resolveIanaZone("")).toBeNull();
    expect(resolveIanaZone(null)).toBeNull();
    expect(resolveIanaZone(undefined)).toBeNull();
  });
});

describe("zonedWallClockToUtcMs", () => {
  it("New York midnight in summer is EDT (UTC-4)", () => {
    const ms = zonedWallClockToUtcMs(2026, 6, 23, 0, 0, 0, "America/New_York");
    expect(new Date(ms).toISOString()).toBe("2026-06-23T04:00:00.000Z");
  });
  it("New York midnight in winter is EST (UTC-5)", () => {
    const ms = zonedWallClockToUtcMs(2026, 1, 15, 0, 0, 0, "America/New_York");
    expect(new Date(ms).toISOString()).toBe("2026-01-15T05:00:00.000Z");
  });
  it("UTC wall clock maps to itself", () => {
    const ms = zonedWallClockToUtcMs(2026, 6, 23, 9, 30, 0, "UTC");
    expect(new Date(ms).toISOString()).toBe("2026-06-23T09:30:00.000Z");
  });
});

describe("normalizeGraphDateTime", () => {
  it("leaves an already Z-designated value untouched", () => {
    expect(normalizeGraphDateTime("2026-06-23T14:00:00Z", "UTC")).toBe(
      "2026-06-23T14:00:00Z",
    );
  });
  it("leaves a numeric-offset value untouched", () => {
    expect(normalizeGraphDateTime("2026-06-23T14:00:00-04:00", "Eastern Standard Time")).toBe(
      "2026-06-23T14:00:00-04:00",
    );
  });
  it("appends Z when Graph says the naive value is UTC", () => {
    expect(normalizeGraphDateTime("2026-06-23T14:00:00.0000000", "UTC")).toBe(
      "2026-06-23T14:00:00.0000000Z",
    );
  });
  it("converts a Windows-zoned OOO wall clock to the correct UTC instant", () => {
    // This is the Meg bug: midnight on the 24th in Eastern (a Windows zone
    // name) must become 04:00Z on the 24th, NOT 00:00Z (which reads as the
    // 23rd at 8pm Eastern and shows the person out a day early).
    expect(
      normalizeGraphDateTime("2026-06-24T00:00:00.0000000", "Eastern Standard Time"),
    ).toBe("2026-06-24T04:00:00.000Z");
  });
  it("converts an IANA-zoned wall clock", () => {
    expect(
      normalizeGraphDateTime("2026-01-15T09:00:00", "America/Los_Angeles"),
    ).toBe("2026-01-15T17:00:00.000Z"); // PST UTC-8
  });
  it("NEVER throws and always returns a string (totality: this runs on every event)", () => {
    /* Regression: normalizeGraphDateTime ran on every calendar/mailbox datetime;
       a non-finite instant made new Date().toISOString() throw, which both
       calendar surfaces swallowed into a blank "no meetings". It must be total. */
    const inputs: [string, string | null | undefined][] = [
      ["2026-06-24T09:00:00.0000000", "Eastern Standard Time"],
      ["2026-02-29T00:00:00", "America/New_York"],
      ["9999-12-31T23:59:59", "Pacific Standard Time"],
      ["0001-01-01T00:00:00", "UTC"],
      ["not-a-date", "Eastern Standard Time"],
      ["", "UTC"],
      ["2026-06-24T09:00:00", undefined],
      ["2026-06-24T09:00:00", "Totally Made Up Zone"],
    ];
    for (const [dt, tz] of inputs) {
      expect(() => normalizeGraphDateTime(dt, tz)).not.toThrow();
      expect(typeof normalizeGraphDateTime(dt, tz)).toBe("string");
    }
  });
  it("dayWindowInTimeZone never throws and yields valid ISO bounds", () => {
    for (const tz of ["Eastern Standard Time", "UTC", "Totally Made Up Zone", undefined]) {
      const w = dayWindowInTimeZone(tz, Date.UTC(2026, 5, 24, 10, 36, 0));
      expect(() => new Date(w.startUtcIso).toISOString()).not.toThrow();
      expect(Number.isNaN(new Date(w.startUtcIso).getTime())).toBe(false);
      expect(Number.isNaN(new Date(w.endUtcIso).getTime())).toBe(false);
    }
  });
  it("returns the value unchanged for an unknown zone (no invented instant)", () => {
    expect(normalizeGraphDateTime("2026-06-23T14:00:00", "Narnia Standard Time")).toBe(
      "2026-06-23T14:00:00",
    );
  });
});

describe("dayWindowInTimeZone", () => {
  it("New York summer day is a UTC-4 slice", () => {
    const ref = Date.parse("2026-06-23T15:00:00Z"); // 11am EDT on the 23rd
    const win = dayWindowInTimeZone("America/New_York", ref);
    expect(win.localDate).toBe("2026-06-23");
    expect(win.startUtcIso).toBe("2026-06-23T04:00:00.000Z");
    expect(win.endUtcIso).toBe("2026-06-24T04:00:00.000Z");
  });
  it("late-evening UTC instant still resolves to the correct local day", () => {
    // 2am UTC on the 24th is 10pm EDT on the 23rd. The window must be the
    // 23rd local day, not the 24th. This is the combining-days fix: a UTC
    // 'today' bucket would wrongly pull this in as the 24th.
    const ref = Date.parse("2026-06-24T02:00:00Z");
    const win = dayWindowInTimeZone("America/New_York", ref);
    expect(win.localDate).toBe("2026-06-23");
    expect(win.startUtcIso).toBe("2026-06-23T04:00:00.000Z");
    expect(win.endUtcIso).toBe("2026-06-24T04:00:00.000Z");
  });
  it("falls back to a UTC day for an unknown zone", () => {
    const ref = Date.parse("2026-06-23T15:00:00Z");
    const win = dayWindowInTimeZone("Narnia", ref);
    expect(win.startUtcIso).toBe("2026-06-23T00:00:00.000Z");
    expect(win.endUtcIso).toBe("2026-06-24T00:00:00.000Z");
  });
});

describe("isSameLocalDay", () => {
  const refOn23rd = Date.parse("2026-06-23T15:00:00Z"); // 11am EDT on the 23rd
  it("an event at 1am UTC on the 24th is still 'today' (the 23rd) in New York", () => {
    expect(isSameLocalDay("2026-06-24T01:00:00Z", "America/New_York", refOn23rd)).toBe(
      true,
    );
  });
  it("an event at 5am UTC on the 24th is 'tomorrow' (the 24th) in New York", () => {
    // 5am UTC = 1am EDT on the 24th -> next local day.
    expect(isSameLocalDay("2026-06-24T05:00:00Z", "America/New_York", refOn23rd)).toBe(
      false,
    );
  });
});
