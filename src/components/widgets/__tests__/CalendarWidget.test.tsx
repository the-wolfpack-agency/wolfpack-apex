/**
 * @jest-environment jsdom
 *
 * CalendarWidget — renders the mini month grid, expands a day on click,
 * shows event rows, and emits analytics when interacted with.
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { CalendarWidget } from "@/components/widgets/CalendarWidget";
import type { CalendarWidgetSpec } from "@/lib/assistant/widgets/types";

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
});

/* Use mid-May 2026 as our deterministic month. May 1, 2026 is a Friday. */
const spec: CalendarWidgetSpec = {
  kind: "calendar",
  month: "2026-05-01T00:00:00.000Z",
  rangeStart: "2026-05-01T00:00:00.000Z",
  rangeEnd: "2026-06-01T00:00:00.000Z",
  title: "Your calendar",
  events: [
    {
      id: "evt-a",
      subject: "Demo prep",
      start: "2026-05-16T15:00:00Z",
      end: "2026-05-16T16:00:00Z",
      location: "Zoom",
      isOnlineMeeting: true,
      webLink: "https://outlook.office.com/evt-a",
      instinctDetailHref: "/meetings/feeds/event/evt-a",
    },
    {
      id: "evt-b",
      subject: "1:1 with Hoxsie",
      start: "2026-05-20T18:00:00Z",
      end: "2026-05-20T18:30:00Z",
      isOnlineMeeting: false,
      webLink: null,
      instinctDetailHref: "/meetings/feeds/event/evt-b",
    },
  ],
};

describe("CalendarWidget", () => {
  test("renders month header + day-of-week strip", () => {
    render(<CalendarWidget spec={spec} />);
    expect(screen.getByText(/Your calendar:/)).toBeInTheDocument();
    expect(screen.getByText(/May 2026/)).toBeInTheDocument();
    /* The DAY_NAMES strip has two T's and two S's, just verify M/W/F exist. */
    expect(screen.getByText("M")).toBeInTheDocument();
    expect(screen.getByText("W")).toBeInTheDocument();
    expect(screen.getByText("F")).toBeInTheDocument();
  });

  test("renders a button for each day of the month + dots on event days", () => {
    render(<CalendarWidget spec={spec} />);
    /* May has 31 days. */
    for (let d = 1; d <= 31; d++) {
      const key = `2026-05-${String(d).padStart(2, "0")}`;
      expect(screen.getByTestId(`calendar-day-${key}`)).toBeInTheDocument();
    }
    /* Dots only on the days with events. Day depends on local TZ for the
     * 15:00Z event — under jsdom UTC the dot lands on 05-16. The 18:00Z
     * event lands on 05-20. We assert both via the data-testid pattern. */
    expect(screen.getByTestId("calendar-dot-2026-05-16")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-dot-2026-05-20")).toBeInTheDocument();
    expect(screen.queryByTestId("calendar-dot-2026-05-15")).not.toBeInTheDocument();
  });

  test("clicking a non-today day with events expands its meeting list", () => {
    render(<CalendarWidget spec={spec} />);
    fireEvent.click(screen.getByTestId("calendar-day-2026-05-20"));
    expect(screen.getByTestId("calendar-day-events-2026-05-20")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-event-evt-b")).toBeInTheDocument();
    expect(screen.getByText("1:1 with Hoxsie")).toBeInTheDocument();
  });

  test("event row links to Instinct detail; Outlook link only when webLink set", () => {
    render(<CalendarWidget spec={spec} />);
    fireEvent.click(screen.getByTestId("calendar-day-2026-05-20"));
    const instinctB = screen.getByText("Open in Instinct") as HTMLAnchorElement;
    expect(instinctB.getAttribute("href")).toBe("/meetings/feeds/event/evt-b");
    /* evt-b has webLink=null, so no Outlook link should render. */
    expect(screen.queryByText("Open in Outlook")).not.toBeInTheDocument();
  });

  /* ----------------------------------------------------------------
   * Regression: 2026-05-17 — clicking May 17 (Sun) printed
   * "Saturday, May 16" in the selected-day header because
   * `new Date("2026-05-17")` parses as UTC midnight, which renders
   * as the previous local day in any TZ west of UTC. The fix parses
   * day-keys as local-noon dates. This test fires regardless of the
   * test runner's TZ.
   * ---------------------------------------------------------------- */
  test("selected-day header matches the clicked day (no UTC-shift)", () => {
    render(<CalendarWidget spec={spec} />);
    fireEvent.click(screen.getByTestId("calendar-day-2026-05-20"));
    const panel = screen.getByTestId("calendar-day-events-2026-05-20");
    /* May 20, 2026 is a Wednesday — assert the weekday + day match
     * the clicked cell, NOT the UTC-shifted previous day. */
    expect(panel.textContent).toMatch(/Wednesday/);
    expect(panel.textContent).toMatch(/May 20/);
    expect(panel.textContent).not.toMatch(/May 19/);
  });

  test("event with webLink shows Outlook link", () => {
    render(<CalendarWidget spec={spec} />);
    /* Pick a day that's not today. Force-toggle into 05-16 by clicking
     * twice if needed — first click may close (if today=16) or open it. */
    const day16 = screen.getByTestId("calendar-day-2026-05-16");
    fireEvent.click(day16);
    if (!screen.queryByTestId("calendar-day-events-2026-05-16")) {
      fireEvent.click(day16);
    }
    const outlook = screen.getByText("Open in Outlook") as HTMLAnchorElement;
    expect(outlook.getAttribute("href")).toBe("https://outlook.office.com/evt-a");
  });

  test("fires widget_rendered analytics event on mount", () => {
    render(<CalendarWidget spec={spec} />);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/analytics",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("assistant.widget_rendered"),
      }),
    );
  });

  test("clicking a day fires widget_interaction analytics", () => {
    render(<CalendarWidget spec={spec} />);
    mockFetch.mockClear();
    fireEvent.click(screen.getByTestId("calendar-day-2026-05-20"));
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/analytics",
      expect.objectContaining({
        body: expect.stringContaining("expand_day"),
      }),
    );
  });

  test("toggling the same day off collapses the list", () => {
    render(<CalendarWidget spec={spec} />);
    fireEvent.click(screen.getByTestId("calendar-day-2026-05-20"));
    expect(screen.getByTestId("calendar-day-events-2026-05-20")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("calendar-day-2026-05-20"));
    expect(screen.queryByTestId("calendar-day-events-2026-05-20")).not.toBeInTheDocument();
  });

  test("renders without events gracefully", () => {
    render(<CalendarWidget spec={{ ...spec, events: [] }} />);
    expect(screen.getByText(/May 2026/)).toBeInTheDocument();
    /* No dots anywhere. */
    expect(screen.queryByTestId(/calendar-dot-/)).not.toBeInTheDocument();
  });

  /* ----------------------------------------------------------------
   * Workflow correlation: workflowId prop threads into every analytics
   * event the widget fires (mount + click) so client-side rows join
   * the funnel started by the originating chat() turn.
   * ---------------------------------------------------------------- */
  test("workflowId is forwarded into widget_rendered + widget_interaction analytics", () => {
    render(<CalendarWidget spec={spec} workflowId="wf-abc" />);
    /* Mount fires widget_rendered. */
    const renderedBody = mockFetch.mock.calls.find((c) =>
      (c[1]?.body || "").includes("widget_rendered"),
    )?.[1]?.body;
    expect(renderedBody).toContain('"workflow_id":"wf-abc"');
    /* Click any day-with-events → widget_interaction. */
    mockFetch.mockClear();
    fireEvent.click(screen.getByTestId("calendar-day-2026-05-20"));
    const interactionBody = mockFetch.mock.calls.find((c) =>
      (c[1]?.body || "").includes("widget_interaction"),
    )?.[1]?.body;
    expect(interactionBody).toContain('"workflow_id":"wf-abc"');
  });

  test("workflowId omitted when prop not passed (back-compat)", () => {
    render(<CalendarWidget spec={spec} />);
    const renderedBody = mockFetch.mock.calls.find((c) =>
      (c[1]?.body || "").includes("widget_rendered"),
    )?.[1]?.body;
    expect(renderedBody).not.toContain("workflow_id");
  });
});
