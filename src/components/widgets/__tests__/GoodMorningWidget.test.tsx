/**
 * @jest-environment jsdom
 *
 * GoodMorningWidget — DOM render: greeting + summary, schedule section
 * (events vs empty), action items (priority chip + link wiring), the
 * disconnected hint, and analytics fire on mount + click.
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { GoodMorningWidget } from "@/components/widgets/GoodMorningWidget";
import type { GoodMorningWidgetSpec } from "@/lib/assistant/widgets/types";

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
});

const futureIso = (minsFromNow: number) =>
  new Date(Date.now() + minsFromNow * 60_000).toISOString();

const fullSpec: GoodMorningWidgetSpec = {
  kind: "good_morning",
  greeting: "Good morning, Nick",
  summary: "Your calendar is clear today.",
  schedule: {
    eventCount: 1,
    events: [
      {
        subject: "Jorge traveling: VA - FL",
        startTime: "2026-05-17T20:00:00Z",
        endTime: "2026-05-17T21:00:00Z",
        attendees: ["Jorge", "Alicia", "Ashley", "David"],
        location: "Zoom",
      },
    ],
  },
  actionItems: [
    {
      priority: "high",
      text: "Reply to client about Q3",
      context: "from hoxsie@thewolfpack.agency",
      source: "email",
      link: "https://outlook.office.com/msg-1",
    },
    {
      priority: "medium",
      text: "Review the SE-FI proposal",
      context: "due Friday",
      source: "meeting",
    },
  ],
  preBrief: {
    defaultMeetingId: "m1",
    lookaheadHours: 48,
    meetings: [
      {
        id: "m1",
        subject: "Demo prep",
        start: futureIso(30),
        end: futureIso(60),
        location: "Zoom",
        attendees: ["alice@x.co", "bob@x.co", "carol@x.co"],
        isOnlineMeeting: true,
        minutesUntil: 30,
        inProgress: false,
      },
      {
        id: "m2",
        subject: "1:1 with Hoxsie",
        start: futureIso(1200),
        end: futureIso(1230),
        location: "",
        attendees: ["hoxsie@x.co"],
        isOnlineMeeting: false,
        minutesUntil: 1200,
        inProgress: false,
      },
    ],
  },
  connected: true,
};

describe("GoodMorningWidget", () => {
  test("renders greeting + summary + Open dashboard link", () => {
    render(<GoodMorningWidget spec={fullSpec} />);
    expect(screen.getByTestId("good-morning-widget")).toBeInTheDocument();
    /* Greeting is recomputed client-side using the browser's clock
       (not the server's UTC) to fix the 2026-05-20 "Good evening at
       1 PM CST" bug. Assert against the local time the test runner
       is in, preserving the ", Nick" suffix from the spec. */
    const hour = new Date().getHours();
    const expected =
      hour < 12 ? "Good morning, Nick" : hour < 17 ? "Good afternoon, Nick" : "Good evening, Nick";
    expect(screen.getByText(expected)).toBeInTheDocument();
    expect(screen.getByText("Your calendar is clear today.")).toBeInTheDocument();
    expect(screen.getByText(/Open dashboard/)).toBeInTheDocument();
  });

  test("schedule section renders each event with time + attendee count + location", () => {
    render(<GoodMorningWidget spec={fullSpec} />);
    const row = screen.getByTestId("good-morning-event-0");
    expect(row).toBeInTheDocument();
    expect(within(row).getByText("Jorge traveling: VA - FL")).toBeInTheDocument();
    expect(within(row).getByText(/4 attendees/)).toBeInTheDocument();
    expect(within(row).getByText(/Zoom/)).toBeInTheDocument();
  });

  test("action items render priority chip + link wiring", () => {
    render(<GoodMorningWidget spec={fullSpec} />);
    expect(screen.getByText("Reply to client about Q3")).toBeInTheDocument();
    expect(screen.getByText("High")).toBeInTheDocument();
    expect(screen.getByText("Med")).toBeInTheDocument();
    const linked = screen.getByText("Reply to client about Q3").closest("a") as HTMLAnchorElement;
    expect(linked?.getAttribute("href")).toBe("https://outlook.office.com/msg-1");
    expect(linked?.getAttribute("target")).toBe("_blank");
  });

  test("empty schedule shows 'No meetings' state", () => {
    render(
      <GoodMorningWidget
        spec={{ ...fullSpec, schedule: { eventCount: 0, events: [] } }}
      />,
    );
    expect(screen.getByTestId("good-morning-schedule-empty")).toBeInTheDocument();
  });

  test("empty action items shows 'Nothing urgent' state", () => {
    render(<GoodMorningWidget spec={{ ...fullSpec, actionItems: [] }} />);
    expect(screen.getByTestId("good-morning-actions-empty")).toBeInTheDocument();
  });

  test("not-connected spec renders the Settings hint", () => {
    render(<GoodMorningWidget spec={{ ...fullSpec, connected: false }} />);
    expect(screen.getByTestId("good-morning-disconnected")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });

  test("fires widget_rendered analytics on mount", () => {
    render(<GoodMorningWidget spec={fullSpec} />);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/analytics",
      expect.objectContaining({
        body: expect.stringContaining("assistant.widget_rendered"),
      }),
    );
  });

  test("clicking the dashboard link fires widget_interaction", () => {
    render(<GoodMorningWidget spec={fullSpec} />);
    mockFetch.mockClear();
    fireEvent.click(screen.getByText(/Open dashboard/));
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/analytics",
      expect.objectContaining({
        body: expect.stringContaining("open_dashboard"),
      }),
    );
  });

  test("Meeting Pre-Brief section renders with default selection", () => {
    render(<GoodMorningWidget spec={fullSpec} />);
    expect(screen.getByTestId("good-morning-prebrief")).toBeInTheDocument();
    expect(screen.getByTestId("good-morning-prebrief-picker")).toBeInTheDocument();
    /* Default meeting is m1 (Demo prep) — its subject shows in the
     * selected-details panel. */
    const selected = screen.getByTestId("good-morning-prebrief-selected");
    expect(selected).toHaveTextContent("Demo prep");
    expect(selected).toHaveTextContent(/3 attendees/);
    expect(selected).toHaveTextContent(/Zoom/);
    expect(selected).toHaveTextContent(/Teams/);
  });

  test("changing the pre-brief picker swaps the selected meeting", () => {
    render(<GoodMorningWidget spec={fullSpec} />);
    const picker = screen.getByTestId("good-morning-prebrief-picker") as HTMLSelectElement;
    fireEvent.change(picker, { target: { value: "m2" } });
    const selected = screen.getByTestId("good-morning-prebrief-selected");
    expect(selected).toHaveTextContent("1:1 with Hoxsie");
    expect(selected).toHaveTextContent(/1 attendee/);
  });

  test("changing the picker fires select_prebrief_meeting analytics", () => {
    render(<GoodMorningWidget spec={fullSpec} />);
    mockFetch.mockClear();
    fireEvent.change(screen.getByTestId("good-morning-prebrief-picker"), {
      target: { value: "m2" },
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/analytics",
      expect.objectContaining({
        body: expect.stringContaining("select_prebrief_meeting"),
      }),
    );
  });

  test("empty pre-brief renders 'No meetings in the next X hours' hint", () => {
    render(
      <GoodMorningWidget
        spec={{
          ...fullSpec,
          preBrief: { defaultMeetingId: null, meetings: [], lookaheadHours: 48 },
        }}
      />,
    );
    expect(screen.getByTestId("good-morning-prebrief-empty")).toBeInTheDocument();
  });

  test("missing preBrief field → section is not rendered (forward-compat)", () => {
    const noBrief: GoodMorningWidgetSpec = { ...fullSpec };
    delete (noBrief as { preBrief?: unknown }).preBrief;
    render(<GoodMorningWidget spec={noBrief} />);
    expect(screen.queryByTestId("good-morning-prebrief")).not.toBeInTheDocument();
  });

  /* ----------------------------------------------------------------
   * Staggered reveal — schedule rows + action items both wrapped.
   * Action items continue the cascade after the schedule rows so
   * the eye reads top-section then bottom-section instead of two
   * parallel reveals.
   * ---------------------------------------------------------------- */
  test("schedule + action rows render with staggered classes", () => {
    render(<GoodMorningWidget spec={fullSpec} />);
    const schedule = screen.getByTestId("good-morning-event-0");
    expect(schedule.className).toContain("wp-stagger-item");
    expect(schedule.getAttribute("style") || "").toContain("0ms");

    const action0 = screen.getByTestId("good-morning-action-0");
    const action1 = screen.getByTestId("good-morning-action-1");
    expect(action0.className).toContain("wp-stagger-item");
    expect(action1.className).toContain("wp-stagger-item");
    /* fullSpec has 1 schedule event → action items start at index 1
     * (40ms) and 2 (80ms). */
    expect(action0.getAttribute("style") || "").toContain("40ms");
    expect(action1.getAttribute("style") || "").toContain("80ms");
  });

  test("action item link still fires (animation wrap doesn't block clicks)", () => {
    render(<GoodMorningWidget spec={fullSpec} />);
    mockFetch.mockClear();
    fireEvent.click(screen.getByText("Reply to client about Q3"));
    const calls = mockFetch.mock.calls.filter((c) => c[0] === "/api/analytics");
    const bodies = calls.map((c) => String(c[1]?.body || ""));
    expect(bodies.some((b) => b.includes("open_action_item"))).toBe(true);
  });

  test("fires widget.items_revealed once with combined item count", () => {
    render(<GoodMorningWidget spec={fullSpec} />);
    const call = mockFetch.mock.calls.find((c) =>
      String(c[1]?.body || "").includes("widget.items_revealed"),
    );
    const body = JSON.parse(String(call?.[1]?.body || "{}"));
    expect(body.metadata.widget_kind).toBe("good_morning");
    /* 1 schedule event + 2 action items = 3. */
    expect(body.metadata.item_count).toBe(3);
  });
});
