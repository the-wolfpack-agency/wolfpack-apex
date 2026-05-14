import { resolveTimeframe } from "@/lib/assistant/timeframe";

/**
 * Pin "now" to Thursday 2026-05-14 00:00:00 UTC so the weekday math
 * is fully deterministic. Sunday=0, Thursday=4 in JS UTC.
 *
 * Reference week (Sun-Sat layout the resolver uses):
 *   Sun 5/10 · Mon 5/11 · Tue 5/12 · Wed 5/13 · Thu 5/14 · Fri 5/15 · Sat 5/16
 * Next week:
 *   Sun 5/17 · Mon 5/18 · Tue 5/19 · Wed 5/20 · Thu 5/21 · Fri 5/22 · Sat 5/23
 * Last week:
 *   Sun 5/3  · Mon 5/4  · Tue 5/5  · Wed 5/6  · Thu 5/7  · Fri 5/8  · Sat 5/9
 */
const NOW = Date.UTC(2026, 4, 14); // Thursday May 14, 2026

function ymd(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

describe("resolveTimeframe — weekday phrases", () => {
  test("bare 'Monday' resolves to the upcoming Monday (Thu → next Mon)", () => {
    const r = resolveTimeframe("Monday", NOW);
    expect(ymd(r.startMs)).toBe("2026-05-18");
    expect(ymd(r.endMs)).toBe("2026-05-18");
    expect(r.resolved).toBe(true);
    expect(r.label).toBe("Monday");
  });

  test("bare 'Thursday' on a Thursday returns today", () => {
    const r = resolveTimeframe("Thursday", NOW);
    expect(ymd(r.startMs)).toBe("2026-05-14");
    expect(r.label).toContain("today");
  });

  test("'next Monday' is next week's Monday", () => {
    const r = resolveTimeframe("next Monday", NOW);
    expect(ymd(r.startMs)).toBe("2026-05-18");
    expect(r.label).toBe("Monday of next week");
  });

  test("'Monday of next week' is next week's Monday", () => {
    const r = resolveTimeframe("Monday of next week", NOW);
    expect(ymd(r.startMs)).toBe("2026-05-18");
    expect(r.label).toBe("Monday of next week");
  });

  test("'this Monday' is this week's Monday (past relative to Thursday)", () => {
    const r = resolveTimeframe("this Monday", NOW);
    expect(ymd(r.startMs)).toBe("2026-05-11");
    expect(r.label).toBe("Monday of this week");
  });

  test("'last Monday' is last week's Monday", () => {
    const r = resolveTimeframe("last Monday", NOW);
    expect(ymd(r.startMs)).toBe("2026-05-04");
    expect(r.label).toBe("Monday of last week");
  });

  test("'Friday of next week' resolves correctly", () => {
    const r = resolveTimeframe("Friday of next week", NOW);
    expect(ymd(r.startMs)).toBe("2026-05-22");
  });

  test("abbreviated weekday 'Tue' resolves to upcoming Tuesday", () => {
    const r = resolveTimeframe("Tue", NOW);
    expect(ymd(r.startMs)).toBe("2026-05-19");
  });

  test("leading 'on'/'for' is stripped", () => {
    expect(ymd(resolveTimeframe("on Monday", NOW).startMs)).toBe("2026-05-18");
    expect(ymd(resolveTimeframe("for Tuesday", NOW).startMs)).toBe("2026-05-19");
  });

  test("trailing punctuation does not break parsing", () => {
    expect(ymd(resolveTimeframe("Monday?", NOW).startMs)).toBe("2026-05-18");
    expect(ymd(resolveTimeframe("Wednesday.", NOW).startMs)).toBe("2026-05-20");
  });
});

describe("resolveTimeframe — week/month tokens", () => {
  test("'this week' returns Sun-Sat range covering today", () => {
    const r = resolveTimeframe("this week", NOW);
    expect(ymd(r.startMs)).toBe("2026-05-10");
    expect(r.resolved).toBe(true);
  });

  test("'next week' returns next Sun-Sat", () => {
    const r = resolveTimeframe("next week", NOW);
    expect(ymd(r.startMs)).toBe("2026-05-17");
  });

  test("'last week' returns prior Sun-Sat", () => {
    const r = resolveTimeframe("last week", NOW);
    expect(ymd(r.startMs)).toBe("2026-05-03");
  });

  test("canonical underscore tokens still work", () => {
    expect(resolveTimeframe("this_week", NOW).resolved).toBe(true);
    expect(resolveTimeframe("next_quarter", NOW).resolved).toBe(false); // not in switch
  });
});

describe("resolveTimeframe — unresolved fallback", () => {
  test("empty / undefined token returns today with resolved=false", () => {
    expect(resolveTimeframe(undefined, NOW).resolved).toBe(false);
    expect(resolveTimeframe("", NOW).resolved).toBe(false);
  });

  test("gibberish returns today with resolved=false (caller can prompt for clarity)", () => {
    const r = resolveTimeframe("flux capacitor", NOW);
    expect(r.resolved).toBe(false);
    expect(ymd(r.startMs)).toBe("2026-05-14");
  });
});
