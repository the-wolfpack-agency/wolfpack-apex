/**
 * @jest-environment jsdom
 *
 * ClarifyWidget render + interaction tests. Verifies the chip-click
 * fires `instinct:autosubmit` + analytics.
 */

import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockFetchWithRefresh: jest.Mock = jest.fn(() =>
  Promise.resolve({ ok: true, status: 200, json: async () => ({}) }),
);
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: mockFetchWithRefresh,
}));

import React from "react";
import {
  ClarifyWidget,
  CLARIFY_AUTOSUBMIT_EVENT,
} from "@/components/widgets/ClarifyWidget";
import type { ClarifyWidgetSpec } from "@/lib/assistant/widgets/types";

const spec: ClarifyWidgetSpec = {
  kind: "clarify",
  title: "Did you mean…?",
  originalQuery: "insighta",
  suggestions: [
    { label: "insights", query: "insights", hint: "Cross-tool insights" },
    { label: "calendar", query: "calendar", hint: "What's on your calendar" },
  ],
};

beforeEach(() => mockFetchWithRefresh.mockClear());

describe("ClarifyWidget", () => {
  test("renders one button per suggestion + echoes original query", () => {
    render(<ClarifyWidget spec={spec} />);
    expect(screen.getByTestId("clarify-widget")).toBeInTheDocument();
    expect(screen.getByText("insighta", { exact: false })).toBeInTheDocument();
    expect(screen.getByTestId("clarify-suggestion-insights")).toBeInTheDocument();
    expect(screen.getByTestId("clarify-suggestion-calendar")).toBeInTheDocument();
  });

  test("clicking a chip dispatches instinct:autosubmit with the corrected query", () => {
    render(<ClarifyWidget spec={spec} />);
    const events: string[] = [];
    const listener = (ev: Event) => {
      const detail = (ev as CustomEvent<{ prompt?: string }>).detail;
      if (detail?.prompt) events.push(detail.prompt);
    };
    window.addEventListener(CLARIFY_AUTOSUBMIT_EVENT, listener);
    fireEvent.click(screen.getByTestId("clarify-suggestion-insights"));
    window.removeEventListener(CLARIFY_AUTOSUBMIT_EVENT, listener);
    expect(events).toEqual(["insights"]);
  });

  test("chip click emits widget_interaction analytics", () => {
    render(<ClarifyWidget spec={spec} workflowId="w-1" />);
    mockFetchWithRefresh.mockClear();
    fireEvent.click(screen.getByTestId("clarify-suggestion-insights"));
    expect(mockFetchWithRefresh).toHaveBeenCalledWith(
      "/api/analytics",
      expect.objectContaining({
        body: expect.stringContaining("suggestion_clicked"),
      }),
    );
  });

  test("emits widget_rendered analytics on mount", () => {
    render(<ClarifyWidget spec={spec} workflowId="w-1" />);
    expect(mockFetchWithRefresh).toHaveBeenCalledWith(
      "/api/analytics",
      expect.objectContaining({
        body: expect.stringContaining("clarify"),
      }),
    );
  });
});
