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

/* ---------------------------------------------------------------------
 * The same chips, framed as a question rather than a typo correction.
 *
 * A tool that is missing a parameter - "which repository?" - needs exactly
 * this interaction, and the person did not mistype anything. Telling them what
 * they typed reads as a correction they do not deserve.
 * --------------------------------------------------------------- */
describe("when the chips are answering a question, not fixing a typo", () => {
  const spec = {
    kind: "clarify" as const,
    title: "Which repository?",
    originalQuery: "is CI green",
    subtitle: "Pick one and I will run it.",
    suggestions: [
      { label: "wolfpack-apex", query: "is the build green for wolfpack-apex" },
    ],
  };

  it("says the subtitle instead of quoting them back", () => {
    render(<ClarifyWidget spec={spec} />);
    expect(screen.getByText("Pick one and I will run it.")).toBeInTheDocument();
    expect(screen.queryByText(/You typed/)).not.toBeInTheDocument();
  });

  it("still quotes them back when there is no subtitle", () => {
    render(<ClarifyWidget spec={{ ...spec, subtitle: undefined }} />);
    expect(screen.getByText(/You typed/)).toBeInTheDocument();
  });

  /* The button is the whole point: one tap re-sends the question with the
     answer in it, so nobody retypes a sentence the tool already has. */
  it("a tap re-sends the filled-in question", async () => {
    const seen: string[] = [];
    const onSubmit = (e: Event) =>
      seen.push((e as CustomEvent<{ prompt: string }>).detail.prompt);
    window.addEventListener("instinct:autosubmit", onSubmit);
    render(<ClarifyWidget spec={spec} />);
    fireEvent.click(screen.getByText("wolfpack-apex"));
    window.removeEventListener("instinct:autosubmit", onSubmit);
    expect(seen).toEqual(["is the build green for wolfpack-apex"]);
  });
});
