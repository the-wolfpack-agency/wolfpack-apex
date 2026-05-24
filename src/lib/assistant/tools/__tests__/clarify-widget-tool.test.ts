/**
 * clarify_widget — intent matching + handler.
 */

const mockTrackEvent = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/db", () => ({ safeQuery: jest.fn() }));

import {
  clarifyWidgetTool,
  findClarifyMatches,
} from "@/lib/assistant/tools/clarify-widget-tool";

const CTX = { userId: "u1", userRole: "cto" };

beforeEach(() => {
  mockTrackEvent.mockReset();
});

describe("findClarifyMatches", () => {
  test.each([
    ["insighta", "insights"], // 1-char substitution at end
    ["calandar", "calendar"], // 1-char substitution mid
    ["emial", "emails"], // transposition + 1 insertion
    ["depoys", "deploys"], // 1-char deletion
    ["integations", "integrations"], // 1-char deletion
  ])("near-miss '%s' suggests '%s'", (typo, expected) => {
    const m = findClarifyMatches(typo);
    expect(m.length).toBeGreaterThan(0);
    expect(m[0].query).toBe(expected);
  });

  test.each([
    "insights", // exact — no clarify
    "calendar",
    "what should I know today", // long intent-bearing query
    "show me cross-tool insights",
    "find emails from hoxsie", // intent-bearing, multi-word
    "ai", // too short / common
  ])("does NOT suggest for '%s'", (q) => {
    expect(findClarifyMatches(q)).toEqual([]);
  });

  test("matches are sorted by ratio (closest first)", () => {
    /* "isnights" → closer to "insights" (transposition) than to
     * "integrations". Whichever is closer must come first. */
    const m = findClarifyMatches("isnights");
    expect(m.length).toBeGreaterThan(0);
    expect(m[0].query).toBe("insights");
  });

  test("caps suggestions at 3", () => {
    /* "ay" would conceivably match many short canonicals — but the
     * length+ratio filters keep the list tight regardless. Just
     * assert the cap. */
    const m = findClarifyMatches("issuse"); // typo of issues
    expect(m.length).toBeLessThanOrEqual(3);
  });
});

describe("matchIntent", () => {
  test("returns suggestions for a near-miss query", () => {
    const r = clarifyWidgetTool.matchIntent!("insighta");
    expect(r).not.toBeNull();
    expect(r!.suggestions[0].query).toBe("insights");
    expect(r!.originalQuery).toBe("insighta");
  });

  test("returns null for an exact known query (lets the real tool fire)", () => {
    expect(clarifyWidgetTool.matchIntent!("insights")).toBeNull();
  });

  test("returns null for a long intent-bearing query", () => {
    expect(
      clarifyWidgetTool.matchIntent!("show me cross-tool insights"),
    ).toBeNull();
  });
});

describe("handler", () => {
  test("returns clarify widget spec and emits widget_offered analytics", async () => {
    const r = await clarifyWidgetTool.handler(
      {
        originalQuery: "insighta",
        suggestions: [
          { label: "insights", query: "insights", hint: "Cross-tool insights" },
        ],
      },
      CTX,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.widget?.kind).toBe("clarify");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.widget_offered",
      "u1",
      "cto",
      expect.objectContaining({
        widget_kind: "clarify",
        suggestion_count: 1,
        original_query: "insighta",
      }),
    );
  });
});
