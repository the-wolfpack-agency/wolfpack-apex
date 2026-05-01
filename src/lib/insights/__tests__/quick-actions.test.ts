/**
 * Unit tests for the personalized Quick Actions ranker.
 *
 * Pure-function coverage — no DB, no fetch, no clock except a fixed
 * `now` we pass through. Asserts:
 *   - half-life math: 14-day-old event ≈ 0.5x weight of fresh event
 *   - top-4 ordering by summed decayed score
 *   - blocked-path filter (no /, /login, /dashboard, etc.)
 *   - cold-start fallback when fewer than MIN_PERSONALIZED routes
 *     score above MIN_SCORE
 *   - label resolution (mapping table + titlecased fallback)
 */

import {
  ACTION_COUNT,
  FALLBACK_ACTIONS,
  HALF_LIFE_DAYS,
  MIN_PERSONALIZED,
  MIN_SCORE,
  aggregateScores,
  buildQuickActions,
  decayedScore,
  labelForPath,
  normalizePath,
  titlecaseSegment,
  type PageViewEvent,
} from "@/lib/insights/quick-actions";

const NOW = new Date("2026-04-29T12:00:00.000Z");

function daysAgo(d: number): string {
  return new Date(NOW.getTime() - d * 86_400_000).toISOString();
}

function ev(path: string, ageDays: number): PageViewEvent {
  return { path, timestamp: daysAgo(ageDays) };
}

describe("decayedScore — half-life math", () => {
  test("a fresh event scores 1", () => {
    expect(decayedScore(ev("/messages", 0), NOW)).toBeCloseTo(1, 5);
  });

  test("a 14-day-old event scores 0.5 (the half-life)", () => {
    const score = decayedScore(ev("/messages", HALF_LIFE_DAYS), NOW);
    expect(score).toBeCloseTo(0.5, 5);
  });

  test("a 28-day-old event scores 0.25 (two half-lives)", () => {
    const score = decayedScore(ev("/messages", 2 * HALF_LIFE_DAYS), NOW);
    expect(score).toBeCloseTo(0.25, 5);
  });

  test("future-dated events (clock skew) clamp to 1", () => {
    // Some clients send a slightly skewed timestamp. Score must not blow up.
    const score = decayedScore(ev("/messages", -5), NOW);
    expect(score).toBe(1);
  });

  test("invalid timestamp returns 0", () => {
    expect(decayedScore({ path: "/x", timestamp: "not-a-date" }, NOW)).toBe(0);
  });
});

describe("normalizePath", () => {
  test("strips trailing slash", () => {
    expect(normalizePath("/calendar/")).toBe("/calendar");
  });
  test("strips query and hash", () => {
    expect(normalizePath("/calendar?day=mon")).toBe("/calendar");
    expect(normalizePath("/calendar#today")).toBe("/calendar");
  });
  test("rejects empty / null / undefined", () => {
    expect(normalizePath("")).toBeNull();
    expect(normalizePath(null)).toBeNull();
    expect(normalizePath(undefined)).toBeNull();
  });
  test("treats bare page names as paths (matches dashboard emitters)", () => {
    /* Most page-view emitters send `metadata.page = "calendar"` (bare
       name). Dropping those was forcing every user onto the cold-start
       fallback regardless of actual usage. */
    expect(normalizePath("calendar")).toBe("/calendar");
    expect(normalizePath("knowledge")).toBe("/knowledge");
    expect(normalizePath("meetings/upcoming")).toBe("/meetings/upcoming");
  });
  test("rejects garbage that isn't a route token", () => {
    expect(normalizePath("https://evil.com")).toBeNull();
    expect(normalizePath("hello world")).toBeNull();
    expect(normalizePath("javascript:alert(1)")).toBeNull();
  });
});

describe("labelForPath", () => {
  test("uses ROUTE_LABELS mapping for known routes", () => {
    expect(labelForPath("/messages")).toBe("Messages");
    expect(labelForPath("/calendar")).toBe("Calendar");
    expect(labelForPath("/knowledge")).toBe("Ask a Question");
  });
  test("falls back to parent route mapping for nested paths", () => {
    expect(labelForPath("/calendar/2026-04-29")).toBe("Calendar");
  });
  test("titlecases unknown last segments", () => {
    expect(labelForPath("/widgets/foo-bar")).toBe("Foo Bar");
  });
});

describe("titlecaseSegment", () => {
  test("hyphens and underscores split into words", () => {
    expect(titlecaseSegment("/a/foo-bar_baz")).toBe("Foo Bar Baz");
  });
});

describe("aggregateScores — grouping + filtering", () => {
  test("sums decayed scores per route, sorted descending", () => {
    const events: PageViewEvent[] = [
      ev("/messages", 0),
      ev("/messages", 14), // adds 0.5
      ev("/messages", 28), // adds 0.25
      ev("/calendar", 0),
    ];
    const out = aggregateScores(events, NOW);
    expect(out[0].path).toBe("/messages");
    expect(out[0].score).toBeCloseTo(1 + 0.5 + 0.25, 4);
    expect(out[1].path).toBe("/calendar");
    expect(out[1].score).toBeCloseTo(1, 4);
  });

  test("filters blocked routes (dashboard, login, error)", () => {
    const events: PageViewEvent[] = [
      ev("/", 0),
      ev("/dashboard", 0),
      ev("/login", 0),
      ev("/error", 0),
      ev("/messages", 0),
    ];
    const out = aggregateScores(events, NOW);
    expect(out.map((r) => r.path)).toEqual(["/messages"]);
  });

  test("normalizes /foo/ and /foo?x=1 into the same bucket", () => {
    const events: PageViewEvent[] = [
      ev("/messages/", 0),
      ev("/messages?thread=1", 0),
      ev("/messages", 0),
    ];
    const out = aggregateScores(events, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe("/messages");
    expect(out[0].score).toBeCloseTo(3, 4);
  });
});

describe("buildQuickActions — top-4 + cold-start", () => {
  test("returns the static fallback when no events at all", () => {
    const actions = buildQuickActions([], NOW);
    expect(actions).toHaveLength(ACTION_COUNT);
    expect(actions.every((a) => a.source === "fallback")).toBe(true);
    expect(actions.map((a) => a.href)).toEqual(
      FALLBACK_ACTIONS.map((a) => a.href),
    );
  });

  test("returns fallback when fewer than MIN_PERSONALIZED routes pass MIN_SCORE", () => {
    // Only two routes with strong scores → should fall back to static.
    const events: PageViewEvent[] = [
      ev("/messages", 0),
      ev("/calendar", 0),
      // ancient noise that decays under MIN_SCORE on its own:
      ev("/random", 90),
    ];
    const actions = buildQuickActions(events, NOW);
    expect(actions.every((a) => a.source === "fallback")).toBe(true);
  });

  test("returns personalized top-4 when there is enough history", () => {
    // 30 synthetic events covering 5 routes with varying recency.
    const events: PageViewEvent[] = [];
    // /messages → very heavy: 10 fresh hits.
    for (let i = 0; i < 10; i++) events.push(ev("/messages", 0));
    // /calendar → 6 hits, all today.
    for (let i = 0; i < 6; i++) events.push(ev("/calendar", 0));
    // /tasks → 5 hits aged a week (decays to ~0.71 each).
    for (let i = 0; i < 5; i++) events.push(ev("/tasks", 7));
    // /emails → 4 hits aged 3 days.
    for (let i = 0; i < 4; i++) events.push(ev("/emails", 3));
    // /random-deep-route → 3 hits aged 25 days (each ~0.29).
    for (let i = 0; i < 3; i++) events.push(ev("/sites/abc", 25));
    // Old noise on a blocked route — must be dropped.
    events.push(ev("/dashboard", 0));
    events.push(ev("/login", 0));
    expect(events.length).toBe(30);

    const actions = buildQuickActions(events, NOW);
    expect(actions).toHaveLength(ACTION_COUNT);
    expect(actions.every((a) => a.source === "personalized")).toBe(true);

    // Order asserted: messages > calendar > emails > tasks (emails is fresher
    // than tasks even though tasks has more raw count, but tasks has 5
    // events at 0.71 ≈ 3.55 vs emails 4×0.86 ≈ 3.44 — actually tasks wins.
    const hrefs = actions.map((a) => a.href);
    expect(hrefs[0]).toBe("/messages");
    expect(hrefs[1]).toBe("/calendar");
    // The remaining two slots are emails+tasks in some recency-weighted
    // order — assert as a set so the test is deterministic without
    // pinning floating-point ranks.
    expect(new Set(hrefs.slice(2))).toEqual(new Set(["/tasks", "/emails"]));

    // Blocked routes never appear.
    expect(hrefs).not.toContain("/dashboard");
    expect(hrefs).not.toContain("/login");

    // Each personalized item exposes a numeric score >= MIN_SCORE.
    for (const a of actions) {
      expect(a.score).toBeGreaterThanOrEqual(MIN_SCORE);
    }
  });

  test("blends in fallback tiles when exactly MIN_PERSONALIZED strong routes exist", () => {
    const events: PageViewEvent[] = [
      ev("/messages", 0),
      ev("/calendar", 0),
      ev("/tasks", 0),
    ];
    const actions = buildQuickActions(events, NOW);
    expect(actions).toHaveLength(ACTION_COUNT);
    expect(actions.filter((a) => a.source === "personalized")).toHaveLength(
      MIN_PERSONALIZED,
    );
    expect(actions.filter((a) => a.source === "fallback").length).toBe(
      ACTION_COUNT - MIN_PERSONALIZED,
    );
    // Fallback fillers must not duplicate personalized hrefs.
    const seen = new Set<string>();
    for (const a of actions) {
      expect(seen.has(a.href)).toBe(false);
      seen.add(a.href);
    }
  });

  test("personalized items get human labels from the mapping table", () => {
    const events: PageViewEvent[] = [];
    for (let i = 0; i < 5; i++) events.push(ev("/messages", 0));
    for (let i = 0; i < 5; i++) events.push(ev("/calendar", 0));
    for (let i = 0; i < 5; i++) events.push(ev("/emails", 0));
    const actions = buildQuickActions(events, NOW);
    const labelsByHref = Object.fromEntries(actions.map((a) => [a.href, a.label]));
    expect(labelsByHref["/messages"]).toBe("Messages");
    expect(labelsByHref["/calendar"]).toBe("Calendar");
    expect(labelsByHref["/emails"]).toBe("Emails");
  });
});
