/**
 * @jest-environment jsdom
 *
 * GoodMorningWidget — DOM render: greeting + summary, schedule section
 * (events vs empty), action items (priority chip + link wiring), the
 * disconnected hint, and analytics fire on mount + click.
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

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
  connected: true,
};

describe("GoodMorningWidget", () => {
  test("renders greeting + summary + Open dashboard link", () => {
    render(<GoodMorningWidget spec={fullSpec} />);
    expect(screen.getByTestId("good-morning-widget")).toBeInTheDocument();
    expect(screen.getByText("Good morning, Nick")).toBeInTheDocument();
    expect(screen.getByText("Your calendar is clear today.")).toBeInTheDocument();
    expect(screen.getByText("Open dashboard")).toBeInTheDocument();
  });

  test("schedule section renders each event with time + attendee count + location", () => {
    render(<GoodMorningWidget spec={fullSpec} />);
    expect(screen.getByTestId("good-morning-event-0")).toBeInTheDocument();
    expect(screen.getByText("Jorge traveling: VA - FL")).toBeInTheDocument();
    expect(screen.getByText(/4 attendees/)).toBeInTheDocument();
    expect(screen.getByText(/Zoom/)).toBeInTheDocument();
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
    fireEvent.click(screen.getByText("Open dashboard"));
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/analytics",
      expect.objectContaining({
        body: expect.stringContaining("open_dashboard"),
      }),
    );
  });
});
