/**
 * Tests for the 4 Phase-2 tool wrappers.
 *
 * Each tool's underlying run* handler is independently tested elsewhere;
 * these specs cover the ToolDef wrapping layer:
 *   - intent matching (happy + miss)
 *   - parameter extraction
 *   - handler integration (mock the underlying run*; assert dispatch
 *     calls + answer formatting)
 *   - empty-result + thrown-error paths
 */

const mockRunCalendar = jest.fn();
jest.mock("@/lib/assistant/tools/calendar-availability", () => ({
  runCalendarAvailability: (...a: any[]) => mockRunCalendar(...a),
}));

const mockRunMailSearch = jest.fn();
/* The mailbox is reachable by default, so the tests below are about the SEARCH
   rather than about the connection. The unconnected case is its own test: it
   used to be indistinguishable from a search that found nothing, which is the
   bug the connection check was added for. */
const mockGetValidToken = jest.fn();
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...a: unknown[]) => mockGetValidToken(...a),
}));
jest.mock("@/lib/assistant/tools/mail-search", () => ({
  runMailSearch: (...a: any[]) => mockRunMailSearch(...a),
}));

const mockRunGoals = jest.fn();
jest.mock("@/lib/assistant/tools/goals-lookup", () => ({
  runGoalsLookup: (...a: any[]) => mockRunGoals(...a),
}));

const mockRunFinancials = jest.fn();
jest.mock("@/lib/assistant/tools/financials-metric", () => ({
  runFinancialsMetric: (...a: any[]) => mockRunFinancials(...a),
  runFinancialsMetricOutcome: (...a: any[]) => mockRunFinancials(...a),
}));

import { getCalendarAvailabilityTool } from "@/lib/assistant/tools/get-calendar-availability-tool";
import { searchMailTool } from "@/lib/assistant/tools/search-mail-tool";
import { getGoalsTool } from "@/lib/assistant/tools/get-goals-tool";
import { getFinancialsMetricTool } from "@/lib/assistant/tools/get-financials-metric-tool";

const ctx = { userId: "u1", userRole: "cto", userEmail: "a@x.com" };

beforeEach(() => {
  mockRunCalendar.mockReset();
  mockRunMailSearch.mockReset();
  mockRunGoals.mockReset();
  mockRunFinancials.mockReset();
});

/* -------------------- get_calendar_availability -------------------- */

describe("get_calendar_availability — intent", () => {
  test.each([
    ["Am I free Thursday?", { isSelfQuery: true }],
    ["what's on my calendar today?", { isSelfQuery: true }],
    ["Is Jorge free Thursday?", { personName: "Jorge", isSelfQuery: false }],
    ["When is Max available this week?", { personName: "Max", isSelfQuery: false }],
  ])("matches '%s'", (msg, expected) => {
    const r = getCalendarAvailabilityTool.matchIntent(msg);
    expect(r).toMatchObject(expected);
  });

  test("misses unrelated questions", () => {
    expect(getCalendarAvailabilityTool.matchIntent("what are our OKRs")).toBeNull();
    expect(getCalendarAvailabilityTool.matchIntent("find emails from Max")).toBeNull();
  });
});

describe("get_calendar_availability — handler", () => {
  test("returns the runCalendarAvailability answer when available", async () => {
    mockRunCalendar.mockResolvedValueOnce({ answer: "You're free Thursday 9am-12pm.", busy: [], free: [] });
    const r = await getCalendarAvailabilityTool.handler(
      { isSelfQuery: true, timeframe: "Thursday" },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.answer).toContain("Thursday 9am");
  });

  test("returns graceful empty-state when underlying handler returns null", async () => {
    mockRunCalendar.mockResolvedValueOnce(null);
    const r = await getCalendarAvailabilityTool.handler(
      { isSelfQuery: false, personName: "Ghost", timeframe: "tomorrow" },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.answer).toContain("Ghost");
  });

  test("returns internal failure when handler throws", async () => {
    mockRunCalendar.mockRejectedValueOnce(new Error("graph 500"));
    const r = await getCalendarAvailabilityTool.handler({ isSelfQuery: true }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("internal");
  });
});

/* -------------------- search_mail -------------------- */

describe("search_mail — intent", () => {
  test.each([
    ["find emails from Max", { from: "Max" }],
    ["find emails to Hoxsie", { to: "Hoxsie" }],
    ["search emails to Sarah about Q3", { to: "Sarah", topic: "Q3" }],
    ["did I email Hoxsie about the proposal", { to: "Hoxsie", topic: "the proposal" }],
    ["have I emailed Max", { to: "Max" }],
    ["search emails about Q3 launch", { topic: "Q3 launch" }],
    ["find emails from Jorge about renewal", { from: "Jorge", topic: "renewal" }],
    ["did Max email me about pricing?", { from: "Max", topic: "pricing" }],
  ])("matches '%s'", (msg, expected) => {
    expect(searchMailTool.matchIntent(msg)).toMatchObject(expected);
  });

  test("misses unrelated", () => {
    expect(searchMailTool.matchIntent("what are our OKRs")).toBeNull();
    expect(searchMailTool.matchIntent("am i free thursday")).toBeNull();
  });

  test("paramSchema requires at least one of from/to/topic", () => {
    expect(searchMailTool.paramSchema.safeParse({}).success).toBe(false);
    expect(searchMailTool.paramSchema.safeParse({ from: "x" }).success).toBe(true);
    expect(searchMailTool.paramSchema.safeParse({ to: "x" }).success).toBe(true);
    expect(searchMailTool.paramSchema.safeParse({ topic: "y" }).success).toBe(true);
  });
});

describe("search_mail — handler", () => {
  test("returns count-aware answer when results found", async () => {
    mockRunMailSearch.mockResolvedValueOnce({ count: 3, messages: [] });
    const r = await searchMailTool.handler({ from: "Max" }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.answer).toMatch(/3 emails? from/i);
      expect(r.answer).toContain("Max");
    }
  });

  test("returns empty-state naming the query when the mailbox IS reachable", async () => {
    mockGetValidToken.mockResolvedValue({ accessToken: "tok", userEmail: "a@b.co" });
    mockRunMailSearch.mockResolvedValueOnce(null);
    const r = await searchMailTool.handler({ from: "Ghost" }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.answer).toContain("Ghost");
  });

  /* AN UNCONNECTED MAILBOX IS NOT AN EMPTY ONE.
     The matcher returns [] when there is no token, which is the same [] it
     returns when nothing matched, so this rendered both as "I didn't find any
     emails about pricing". Measured against a client-facing starter prompt on
     2026-08-28. The reader cannot tell "nothing matched" from "we never
     looked", and only one of them is worth acting on. */
  test("says Microsoft is not connected rather than claiming no emails", async () => {
    mockGetValidToken.mockResolvedValue(null);
    mockRunMailSearch.mockResolvedValueOnce(null);
    const r = await searchMailTool.handler({ topic: "pricing" }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.answer).toMatch(/not connected/i);
      expect(r.answer).not.toMatch(/didn't find any emails/i);
    }
  });

  /* The connection is only checked when the result is empty, so an ordinary
     answer costs no extra call. */
  test("does not check the connection when there are results", async () => {
    mockGetValidToken.mockClear();
    mockRunMailSearch.mockResolvedValueOnce({ messages: [], count: 3, answer: "3 emails from Max" });
    await searchMailTool.handler({ from: "Max" }, ctx);
    expect(mockGetValidToken).not.toHaveBeenCalled();
  });
});

/* -------------------- get_goals -------------------- */

describe("get_goals — intent", () => {
  test.each([
    "what are our OKRs?",
    "show me our goals",
    "what's our north star?",
    "how are we doing on our objectives?",
    "north star metric please",
  ])("matches '%s'", (msg) => {
    expect(getGoalsTool.matchIntent(msg)).toEqual({});
  });

  test.each([
    "hello",
    "find emails from Max",
    "what do we know about Acme",
  ])("misses '%s'", (msg) => {
    expect(getGoalsTool.matchIntent(msg)).toBeNull();
  });
});

describe("get_goals — handler", () => {
  test("returns runGoalsLookup answer when goals exist", async () => {
    mockRunGoals.mockResolvedValueOnce({
      okrs: [{ id: "okr1" }],
      northStar: { label: "ARR", value: 100, unit: "$" },
      answer: "Q3 objective is shipping the assistant.",
      source: "goals",
    });
    const r = await getGoalsTool.handler({}, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.answer).toContain("Q3");
  });

  test("returns empty-state when handler returns null", async () => {
    mockRunGoals.mockResolvedValueOnce(null);
    const r = await getGoalsTool.handler({}, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.answer.toLowerCase()).toContain("no okrs");
  });
});

/* -------------------- get_financials_metric -------------------- */

describe("get_financials_metric — intent", () => {
  test.each([
    "what's our revenue this quarter?",
    "how much did we spend on marketing last month",
    "show me our burn rate",
    "what was our MRR ytd",
  ])("matches '%s'", (msg) => {
    expect(getFinancialsMetricTool.matchIntent(msg)).not.toBeNull();
  });

  test("does NOT match casual mentions without a question framing", () => {
    expect(getFinancialsMetricTool.matchIntent("revenue is up")).toBeNull();
    expect(getFinancialsMetricTool.matchIntent("the budget feels tight")).toBeNull();
  });

  test("extracts timeframe when present", () => {
    const r = getFinancialsMetricTool.matchIntent("what's our revenue this quarter?");
    expect(r?.timeframe).toBe("this quarter");
  });
});

describe("get_financials_metric — handler", () => {
  test("returns handler answer when metric resolved", async () => {
    mockRunFinancials.mockResolvedValueOnce({
      ok: true,
      result: { metric: "revenue", value: 1234567, answer: "Revenue this quarter: $1.23M." },
    });
    const r = await getFinancialsMetricTool.handler(
      { question: "what's our revenue this quarter?", timeframe: "this quarter" },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.answer).toContain("$1.23M");
  });

  /* Was: asserted the one-size-fits-all "matching financial metric" message.
     That message blamed the user's wording for a disconnected accounting
     system and suggested a rephrasing that was the question which had just
     failed. The answer now depends on WHY, so the test does too. */
  test("names the missing connection rather than the user's wording", async () => {
    mockRunFinancials.mockResolvedValueOnce({ ok: false, reason: "not_connected" });
    const r = await getFinancialsMetricTool.handler(
      { question: "what's our revenue?" },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.answer).toMatch(/not connected/i);
      expect(r.answer).not.toMatch(/more specific/i);
    }
  });

  test("capability is 'cto' (admin-only)", () => {
    expect(getFinancialsMetricTool.capability).toBe("cto");
  });
});
