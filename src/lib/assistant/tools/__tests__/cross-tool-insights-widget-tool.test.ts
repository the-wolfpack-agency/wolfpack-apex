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
  ])("'%s' matches", (q) => {
    expect(match(q)).not.toBeNull();
  });

  test.each([
    "what's our revenue this quarter",
    "find emails from hoxsie",
    "show vercel deploys for wolfpack-auto",
    "calendar",
    "what is on my calendar today",
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
      expect.objectContaining({ widget_kind: "cross_tool_insights", insight_count: 1, ok: true }),
    );
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
