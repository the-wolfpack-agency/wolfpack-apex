/**
 * @jest-environment jsdom
 *
 * IntegrationsListWidget render + interaction tests.
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
import { IntegrationsListWidget } from "@/components/widgets/IntegrationsListWidget";
import type { IntegrationsListWidgetSpec } from "@/lib/assistant/widgets/types";

const spec: IntegrationsListWidgetSpec = {
  kind: "integrations_list",
  title: "5 integrations available",
  subtitle: "Click a sample query to try it.",
  items: [
    { id: "search:calendar", name: "Calendar (Microsoft 365)", category: "scheduling", surface: "search+widget", sampleQuery: "what is on my calendar today" },
    { id: "search:emails", name: "Outlook Email", category: "messaging", surface: "search+widget", sampleQuery: "find emails from Alicia" },
    { id: "search:vercel", name: "Vercel Deployments", category: "ops", surface: "search+widget", sampleQuery: "show vercel deploys" },
    { id: "tool:search_github_pull_requests", name: "GitHub Pull Requests", category: "ops", surface: "widget", sampleQuery: "show open PRs" },
    { id: "tool:cross_tool_insights_widget", name: "Cross-Tool Insights", category: "data", surface: "widget", sampleQuery: "show me cross-tool insights" },
  ],
};

beforeEach(() => mockFetchWithRefresh.mockClear());

describe("IntegrationsListWidget", () => {
  test("renders each integration grouped by category", () => {
    render(<IntegrationsListWidget spec={spec} />);
    for (const it of spec.items) {
      expect(screen.getByTestId(`integration-item-${it.id}`)).toBeInTheDocument();
    }
    // Categories appear as section headers
    expect(screen.getByText("scheduling")).toBeInTheDocument();
    expect(screen.getByText("messaging")).toBeInTheDocument();
    expect(screen.getByText("ops")).toBeInTheDocument();
    expect(screen.getByText("data")).toBeInTheDocument();
  });

  test("sample query renders as a clickable button per integration", () => {
    render(<IntegrationsListWidget spec={spec} />);
    expect(screen.getByText(/Try: what is on my calendar today/)).toBeInTheDocument();
  });

  test("emits widget_interaction on sample-query click", () => {
    render(<IntegrationsListWidget spec={spec} workflowId="w-1" />);
    mockFetchWithRefresh.mockClear();
    const btn = screen.getByText(/Try: show vercel deploys/).closest("button")!;
    fireEvent.click(btn);
    expect(mockFetchWithRefresh).toHaveBeenCalledWith(
      "/api/analytics",
      expect.objectContaining({ body: expect.stringContaining("sample_query_clicked") }),
    );
  });

  test("empty state when no integrations", () => {
    const empty: IntegrationsListWidgetSpec = { ...spec, items: [] };
    render(<IntegrationsListWidget spec={empty} />);
    expect(screen.getByTestId("integrations-list-empty")).toHaveTextContent(
      "No integrations registered.",
    );
  });
});
