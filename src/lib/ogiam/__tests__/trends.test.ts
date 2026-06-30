/**
 * Unit tests for the pure OGIAM trends rollups + the window clamp. The query fns
 * are thin date_trunc GROUP BY wrappers over safeQuery (covered by the route
 * contract test + e2e); the bucketing logic is what carries the correctness risk,
 * so it is exercised here from synthetic rows with no DB.
 */

import {
  clampWindowDays,
  dayOf,
  bucketDecisions,
  bucketSurfaces,
  bucketRedTeam,
  OGIAM_TRENDS_DEFAULT_WINDOW_DAYS,
  OGIAM_TRENDS_MAX_WINDOW_DAYS,
} from "../trends";

describe("clampWindowDays", () => {
  it("defaults when absent or non-finite", () => {
    expect(clampWindowDays(undefined)).toBe(OGIAM_TRENDS_DEFAULT_WINDOW_DAYS);
    expect(clampWindowDays(NaN)).toBe(OGIAM_TRENDS_DEFAULT_WINDOW_DAYS);
  });
  it("clamps into [1, MAX]", () => {
    expect(clampWindowDays(0)).toBe(1);
    expect(clampWindowDays(-5)).toBe(1);
    expect(clampWindowDays(10)).toBe(10);
    expect(clampWindowDays(99999)).toBe(OGIAM_TRENDS_MAX_WINDOW_DAYS);
  });
});

describe("dayOf", () => {
  it("passes through a day-shaped string", () => {
    expect(dayOf("2026-06-29")).toBe("2026-06-29");
  });
  it("truncates an ISO timestamp to its UTC day", () => {
    expect(dayOf("2026-06-29T23:59:59.000Z")).toBe("2026-06-29");
  });
});

describe("bucketDecisions", () => {
  it("buckets per day with total + would_block, sorted ascending", () => {
    const out = bucketDecisions([
      { created_at: "2026-06-02T10:00:00Z", would_block: false },
      { created_at: "2026-06-01T10:00:00Z", would_block: true },
      { created_at: "2026-06-01T12:00:00Z", would_block: false },
      { created_at: "2026-06-02T11:00:00Z", would_block: true },
      { created_at: "2026-06-02T12:00:00Z", would_block: true },
    ]);
    expect(out).toEqual([
      { day: "2026-06-01", total: 2, would_block: 1 },
      { day: "2026-06-02", total: 3, would_block: 2 },
    ]);
  });
  it("returns [] for no rows", () => {
    expect(bucketDecisions([])).toEqual([]);
  });
});

describe("bucketSurfaces", () => {
  it("counts only ungoverned, with a running cumulative", () => {
    const out = bucketSurfaces([
      { first_seen_at: "2026-06-01T00:00:00Z", governed: false },
      { first_seen_at: "2026-06-01T05:00:00Z", governed: true }, // excluded
      { first_seen_at: "2026-06-02T00:00:00Z", governed: false },
      { first_seen_at: "2026-06-02T06:00:00Z", governed: false },
    ]);
    expect(out).toEqual([
      { day: "2026-06-01", new_ungoverned: 1, cumulative_ungoverned: 1 },
      { day: "2026-06-02", new_ungoverned: 2, cumulative_ungoverned: 3 },
    ]);
  });
  it("returns [] when every surface is governed", () => {
    expect(
      bucketSurfaces([{ first_seen_at: "2026-06-01T00:00:00Z", governed: true }]),
    ).toEqual([]);
  });
});

describe("bucketRedTeam", () => {
  it("collapses to the latest run per day (rows are newest-first)", () => {
    // Two runs on 06-02: the newest (passRate 0.9) wins; 06-01 has one run.
    const out = bucketRedTeam([
      { created_at: "2026-06-02T18:00:00Z", pass_rate: 0.9, vulns: 1 },
      { created_at: "2026-06-02T09:00:00Z", pass_rate: 1, vulns: 0 },
      { created_at: "2026-06-01T09:00:00Z", pass_rate: 1, vulns: 0 },
    ]);
    expect(out).toEqual([
      { day: "2026-06-01", pass_rate: 1, vulns: 0, runs: 1 },
      { day: "2026-06-02", pass_rate: 0.9, vulns: 1, runs: 2 },
    ]);
  });
  it("returns [] for no runs", () => {
    expect(bucketRedTeam([])).toEqual([]);
  });
});
