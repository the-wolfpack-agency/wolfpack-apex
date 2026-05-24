/**
 * @jest-environment jsdom
 *
 * CrossToolInsightsWidget render + interaction tests.
 */

import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockFetchWithRefresh: jest.Mock = jest.fn(() =>
  Promise.resolve({ ok: true, status: 200, json: async () => ({}) }),
);
jest.mock("@/lib/client-auth", () => ({ fetchWithRefresh: mockFetchWithRefresh }));
jest.mock("@/components/widgets/StaggeredItem", () => ({
  StaggeredItem: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("li", props, children),
  useStaggeredReveal: () => undefined,
}));

import React from "react";
import { CrossToolInsightsWidget } from "@/components/widgets/CrossToolInsightsWidget";
import type { CrossToolInsightsWidgetSpec } from "@/lib/assistant/widgets/types";

const empty: CrossToolInsightsWidgetSpec = {
  kind: "cross_tool_insights",
  title: "No cross-tool insights right now",
  lookbackDays: 30,
  items: [],
  generatorOutcomes: [],
};

const populated: CrossToolInsightsWidgetSpec = {
  kind: "cross_tool_insights",
  title: "2 cross-tool insights",
  subtitle: "Across 2 integrations, 2 of 2 patterns checked.",
  lookbackDays: 30,
  items: [
    {
      id: "github_pr_stagnation:wolfpack-apex#42",
      generator: "github_pr_stagnation",
      severity: "high",
      signalStrength: 95,
      title: "wolfpack-apex#42: open 19 days, no activity",
      detail: "fix: thing that broke",
      action: { label: "Open PR", href: "https://github.com/x/y/pull/42" },
      sources: ["github"],
    },
    {
      id: "vercel_failed_no_followup:d-test",
      generator: "vercel_failed_no_followup",
      severity: "high",
      signalStrength: 90,
      title: "wolfpack-auto: failed production deploy on main",
      detail: null,
      action: { label: "Open Vercel", href: "https://vercel.com/x/y/d" },
      sources: ["vercel", "github"],
    },
  ],
  generatorOutcomes: [
    { name: "github_pr_stagnation", count: 1, ok: true },
    { name: "vercel_failed_no_followup", count: 1, ok: true },
  ],
};

beforeEach(() => mockFetchWithRefresh.mockClear());

describe("CrossToolInsightsWidget", () => {
  test("empty state renders helpful message", () => {
    render(<CrossToolInsightsWidget spec={empty} />);
    expect(screen.getByTestId("cross-tool-insights-widget")).toBeInTheDocument();
    expect(screen.getByTestId("cross-tool-insights-empty")).toHaveTextContent(
      "Nothing crossed the signal threshold.",
    );
  });

  test("renders one row per insight with source badges", () => {
    render(<CrossToolInsightsWidget spec={populated} />);
    expect(
      screen.getByTestId("cross-tool-insight-github_pr_stagnation:wolfpack-apex#42"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("cross-tool-insight-vercel_failed_no_followup:d-test"),
    ).toBeInTheDocument();
    // Source badges for the second insight should include both
    expect(screen.getAllByText("vercel").length).toBeGreaterThan(0);
    expect(screen.getAllByText("github").length).toBeGreaterThan(0);
  });

  test("emits widget_rendered analytics on mount", () => {
    render(<CrossToolInsightsWidget spec={populated} workflowId="w-1" />);
    expect(mockFetchWithRefresh).toHaveBeenCalledWith(
      "/api/analytics",
      expect.objectContaining({
        body: expect.stringContaining("cross_tool_insights"),
      }),
    );
  });

  test("emits widget_interaction on action click", () => {
    render(<CrossToolInsightsWidget spec={populated} workflowId="w-1" />);
    mockFetchWithRefresh.mockClear();
    const link = screen
      .getByTestId("cross-tool-insight-github_pr_stagnation:wolfpack-apex#42")
      .querySelector("a")!;
    fireEvent.click(link);
    expect(mockFetchWithRefresh).toHaveBeenCalledWith(
      "/api/analytics",
      expect.objectContaining({ body: expect.stringContaining("open_action") }),
    );
  });
});
