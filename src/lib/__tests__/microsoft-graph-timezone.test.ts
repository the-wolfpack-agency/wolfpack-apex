/**
 * Regression: Microsoft Graph returns calendar `start.dateTime` /
 * `end.dateTime` as a naive ISO string (no trailing Z or offset)
 * paired with a separate `timeZone` field that defaults to "UTC".
 *
 * JS `new Date("2026-04-21T14:30:00")` parses a naive string as
 * LOCAL time — so a UTC-14:30 meeting renders at 14:30 local on
 * every client. An EDT user (UTC-4) sees 2:30 PM instead of the
 * correct 10:30 AM. normalizeGraphDateTime fixes this by appending
 * Z when the paired timeZone is UTC.
 */
import { normalizeGraphDateTime } from "@/lib/microsoft-graph";

describe("normalizeGraphDateTime", () => {
  it("appends Z when timeZone is UTC and the string lacks an offset", () => {
    expect(normalizeGraphDateTime("2026-04-21T14:30:00.0000000", "UTC")).toBe(
      "2026-04-21T14:30:00.0000000Z",
    );
  });

  it("matches 'utc' case-insensitively (Graph has historically returned both casings)", () => {
    expect(normalizeGraphDateTime("2026-04-21T14:30:00", "utc")).toBe(
      "2026-04-21T14:30:00Z",
    );
  });

  it("leaves an already-Z-terminated string alone", () => {
    expect(normalizeGraphDateTime("2026-04-21T14:30:00Z", "UTC")).toBe(
      "2026-04-21T14:30:00Z",
    );
  });

  it("leaves a +/- offset string alone", () => {
    expect(normalizeGraphDateTime("2026-04-21T10:30:00-04:00", "Eastern Standard Time")).toBe(
      "2026-04-21T10:30:00-04:00",
    );
  });

  it("leaves a non-UTC naive string alone (no regression vs. prior behavior)", () => {
    // If Graph ever returns a non-UTC zone as `timeZone`, we need the
    // caller to know — silently appending Z would be worse than the
    // original naive-local parse.
    expect(normalizeGraphDateTime("2026-04-21T10:30:00", "Pacific Standard Time")).toBe(
      "2026-04-21T10:30:00",
    );
  });

  // End-to-end sanity: the raw UTC value that produced the April 21
  // bug should parse to the correct 10:30 AM EDT wall-clock when
  // normalized, not the wrong 2:30 PM local.
  it("with an EDT (UTC-4) observer, a 14:30 UTC meeting renders as 10:30 AM (not 2:30 PM)", () => {
    const normalized = normalizeGraphDateTime(
      "2026-04-21T14:30:00.0000000",
      "UTC",
    );
    const d = new Date(normalized);
    // Assert UTC wall clock is unchanged — toLocaleTimeString depends
    // on the host timezone which varies across test runners. The
    // epoch value is what actually drives what every locale shows.
    expect(d.toISOString()).toBe("2026-04-21T14:30:00.000Z");
  });
});
