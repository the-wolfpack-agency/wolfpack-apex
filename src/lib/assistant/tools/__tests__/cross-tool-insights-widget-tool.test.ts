/**
 * cross_tool_insights_widget — intent matching + handler shape.
 */

const mockTrackEvent = jest.fn();
const mockRunAll = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/db", () => ({ safeQuery: jest.fn() }));
jest.mock("@/lib/insights/cross-tool-generators", () => ({
  runAllInsightGenerators: (...a: unknown[]) => mockRunAll(...a),
}));

import { crossToolInsightsWidgetTool } from "@/lib/assistant/tools/cross-tool-insights-widget-tool";

const match = (q: string) => crossToolInsightsWidgetTool.matchIntent!(q);
const CTX = { userId: "u1", userRole: "cto" };

beforeEach(() => {
  mockTrackEvent.mockReset();
  mockRunAll.mockReset();
});

describe("intent matching", () => {
  test.each([
    "show me cross-tool insights",
    "what insights do I have",
    "what should I know",
    "give me efficiency insights",
    "cross tool insights",
    "insights across my tools",
    "what insights are there",
    /* SHORT-FORM phrasings real users actually type. Added
     * 2026-05-24 after a user typed "give me insights!" and the
     * regex missed it, routing to RAG cache which served a
     * stale typo-poisoned answer. */
    "insights",
    "insights!",
    "give me insights",
    "give me insights!",
    "any insights",
    "show insights",
    "show me insights",
    "what insights",
    "I want insights",
  ])("'%s' matches", (q) => {
    expect(match(q)).not.toBeNull();
  });

  test.each([
    "what's our revenue this quarter",
    "find emails from hoxsie",
    "show vercel deploys for wolfpack-auto",
    "calendar",
    "what is on my calendar today",
    /* Scoped "<topic> insights" phrasings stay on RAG, not the
     * cross-tool widget. */
    "marketing insights",
    "sales insights for Q3",
    "customer insights",
    "product insights",
    "growth insights",
    "what marketing insights do I have",
  ])("'%s' does NOT match", (q) => {
    expect(match(q)).toBeNull();
  });
});

describe("handler", () => {
  test("returns widget spec with insight items and emits widget_offered", async () => {
    mockRunAll.mockResolvedValueOnce({
      insights: [
        {
          id: "github_pr_stagnation:wolfpack-apex#42",
          generator: "github_pr_stagnation",
          severity: "high" as const,
          signalStrength: 95,
          title: "wolfpack-apex#42: open 19 days, no activity",
          detail: "fix: thing",
          action: { label: "Open PR", href: "https://github.com/x/y/pull/42" },
          sources: ["github"],
        },
      ],
      generatorOutcomes: [
        { name: "github_pr_stagnation", count: 1, ok: true },
        { name: "vercel_failed_no_followup", count: 0, ok: true },
      ],
    });
    const r = await crossToolInsightsWidgetTool.handler({ lookbackDays: 30 }, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data?.insightCount).toBe(1);
    expect(r.widget?.kind).toBe("cross_tool_insights");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.widget_offered",
      "u1",
      "cto",
      expect.objectContaining({
        widget_kind: "cross_tool_insights",
        insight_count: 1,
        cross_tool_count: 0,
        ok: true,
      }),
    );
  });

  test("sorts cross-tool (sources>=2) ahead of single-source items", async () => {
    mockRunAll.mockResolvedValueOnce({
      insights: [
        // single-source FIRST in input
        {
          id: "github_pr_stagnation:r#1",
          generator: "github_pr_stagnation",
          severity: "high" as const,
          signalStrength: 80,
          title: "single source",
          sources: ["github"],
        },
        // cross-tool SECOND in input — must be reordered first
        {
          id: "email_unread_meeting_attendee:em-1",
          generator: "email_unread_from_meeting_attendee",
          severity: "high" as const,
          signalStrength: 80,
          title: "cross tool",
          sources: ["email", "calendar"],
        },
      ],
      generatorOutcomes: [],
    });
    const r = await crossToolInsightsWidgetTool.handler({ lookbackDays: 30 }, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const items = r.widget?.kind === "cross_tool_insights" ? r.widget.items : [];
    expect(items[0].id).toContain("email_unread");
    expect(items[1].id).toContain("github_pr_stagnation");
  });

  test("title reflects cross-tool vs single-tool split honestly", async () => {
    mockRunAll.mockResolvedValueOnce({
      insights: [
        {
          id: "x:1",
          generator: "email_unread_from_meeting_attendee",
          severity: "high" as const,
          signalStrength: 95,
          title: "cross",
          sources: ["email", "calendar"],
        },
        {
          id: "y:1",
          generator: "github_pr_stagnation",
          severity: "medium" as const,
          signalStrength: 50,
          title: "single",
          sources: ["github"],
        },
      ],
      generatorOutcomes: [],
    });
    const r = await crossToolInsightsWidgetTool.handler({ lookbackDays: 30 }, CTX);
    if (!r.ok) return;
    const title =
      r.widget?.kind === "cross_tool_insights" ? r.widget.title : "";
    expect(title).toContain("1 cross-tool insight");
    expect(title).toContain("1 single-tool");
    expect(r.answer).toContain("Cross-tool means combining data from 2+");
  });

  test("answer is honest when only single-source insights exist", async () => {
    mockRunAll.mockResolvedValueOnce({
      insights: [
        {
          id: "y:1",
          generator: "github_pr_stagnation",
          severity: "medium" as const,
          signalStrength: 50,
          title: "single",
          sources: ["github"],
        },
      ],
      generatorOutcomes: [],
    });
    const r = await crossToolInsightsWidgetTool.handler({ lookbackDays: 30 }, CTX);
    if (!r.ok) return;
    expect(r.answer).toContain("All from a single tool");
    expect(r.answer).toContain("connect calendar/email");
  });

  test("empty insights still returns widget (positive-signal UX)", async () => {
    mockRunAll.mockResolvedValueOnce({
      insights: [],
      generatorOutcomes: [
        { name: "github_pr_stagnation", count: 0, ok: true },
        { name: "vercel_failed_no_followup", count: 0, ok: true },
      ],
    });
    const r = await crossToolInsightsWidgetTool.handler({ lookbackDays: 30 }, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.widget?.kind).toBe("cross_tool_insights");
    expect(r.answer).toMatch(/No cross-tool insights/);
  });
});
