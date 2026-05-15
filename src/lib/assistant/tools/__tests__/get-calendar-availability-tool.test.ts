/**
 * get-calendar-availability tool — intent-matching tests.
 *
 * Focused on the SELF_PATTERNS regex so a regression doesn't push
 * "what meetings do I have on Monday" back into the page-facts /
 * "free today" failure mode. The handler itself is covered by
 * calendar-availability.test.ts (which mocks runCalendarAvailability).
 */

jest.mock("@/lib/microsoft-graph", () => ({}));
jest.mock("@/lib/db", () => ({ safeQuery: jest.fn() }));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

import { getCalendarAvailabilityTool } from "@/lib/assistant/tools/get-calendar-availability-tool";

const match = (q: string) => getCalendarAvailabilityTool.matchIntent(q);

describe("self-query intent patterns", () => {
  test.each([
    ["am i free tomorrow", "tomorrow"],
    ["am I free on Monday?", "monday"],
    ["are we busy this afternoon", "this afternoon"],
    ["what's on my calendar for Monday", "monday"],
    ["what is on my calendar tomorrow?", "tomorrow"],
    ["do I have any meetings on Friday", "friday"],
    ["do I have meetings today", undefined],
  ])("'%s' → self-query with timeframe=%s", (msg, expectedTf) => {
    const r = match(msg);
    expect(r).not.toBeNull();
    expect(r?.isSelfQuery).toBe(true);
    if (expectedTf !== undefined) {
      expect((r?.timeframe ?? "").toLowerCase()).toContain(expectedTf);
    }
  });
});

/* ---------------------------------------------------------------------
 * Regression 2026-05-15: "what meetings do I have on Monday" came back
 * with "You look free today" — the existing 'do I have' regex required
 * "meetings|events" to immediately follow "have", which fails for
 * "what meetings do I have ..." phrasing. New leading-noun pattern
 * fixes it.
 * --------------------------------------------------------------- */
describe("regression 2026-05-15 — 'what meetings do I have on X' phrasing", () => {
  test("'what meetings do I have on Monday' matches + captures 'Monday'", () => {
    const r = match("what meetings do I have on Monday");
    expect(r).not.toBeNull();
    expect(r?.isSelfQuery).toBe(true);
    expect((r?.timeframe ?? "").toLowerCase()).toContain("monday");
  });

  test("'any meetings tomorrow?' matches + captures 'tomorrow'", () => {
    const r = match("any meetings tomorrow?");
    expect(r).not.toBeNull();
    expect(r?.isSelfQuery).toBe(true);
    expect((r?.timeframe ?? "").toLowerCase()).toContain("tomorrow");
  });

  test("'my meetings next week' matches + captures 'week'", () => {
    const r = match("my meetings next week");
    expect(r).not.toBeNull();
    expect(r?.isSelfQuery).toBe(true);
    expect((r?.timeframe ?? "").toLowerCase()).toContain("week");
  });

  test("'my schedule Friday' matches + captures 'Friday'", () => {
    const r = match("my schedule Friday");
    expect(r).not.toBeNull();
    expect(r?.isSelfQuery).toBe(true);
    expect((r?.timeframe ?? "").toLowerCase()).toContain("friday");
  });
});

/* ---------------------------------------------------------------------
 * Regression 2026-05-15: "Calendar Monday" returned the page-facts
 * blurb instead of a date-bound calendar lookup. Bare-keyword
 * shortcut + the weekday-aware page-facts bypass (in
 * shouldBypassKnowledgeCache) together fix this. This test pins the
 * intent-match side.
 * --------------------------------------------------------------- */
describe("regression 2026-05-15 — bare 'Calendar <day>' shortcut", () => {
  test("'Calendar Monday' matches + captures 'Monday'", () => {
    const r = match("Calendar Monday");
    expect(r).not.toBeNull();
    expect(r?.isSelfQuery).toBe(true);
    expect((r?.timeframe ?? "").toLowerCase()).toContain("monday");
  });

  test("'schedule Tuesday' matches", () => {
    const r = match("schedule Tuesday");
    expect(r).not.toBeNull();
    expect((r?.timeframe ?? "").toLowerCase()).toContain("tuesday");
  });

  test("'Agenda next week' matches", () => {
    const r = match("Agenda next week");
    expect(r).not.toBeNull();
    expect((r?.timeframe ?? "").toLowerCase()).toContain("week");
  });
});

describe("person-query intent patterns (existing — no regression)", () => {
  test("'is Nick free tomorrow' returns person query", () => {
    const r = match("is Nick free tomorrow");
    expect(r).not.toBeNull();
    expect(r?.isSelfQuery).toBe(false);
    expect(r?.personName?.toLowerCase()).toBe("nick");
  });
});
