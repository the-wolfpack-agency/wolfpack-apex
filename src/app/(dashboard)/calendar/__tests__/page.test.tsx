/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "@testing-library/jest-dom";

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  authHeaders: () => ({ Authorization: "Bearer x" }),
  jsonHeaders: () => ({ "Content-Type": "application/json", Authorization: "Bearer x" }),
}));

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CalendarPage from "@/app/(dashboard)/calendar/page";

function mockRange(payload: unknown, status = 200) {
  mockFetchWithRefresh.mockImplementation((url: string) => {
    if (typeof url === "string" && url.startsWith("/api/calendar/range")) {
      return Promise.resolve({
        status,
        ok: status >= 200 && status < 300,
        json: async () => payload,
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  });
}

const SAMPLE = {
  view: "week",
  range: { startIso: "2026-04-19T00:00:00Z", endIso: "2026-04-25T23:59:59Z" },
  events: [
    {
      id: "e1",
      subject: "Admin Access",
      start: "2026-04-21T10:30:00Z",
      end: "2026-04-21T11:00:00Z",
      location: "Teams",
      attendees: ["Nick Hoxsie"],
    },
  ],
  insights: {
    totalMeetingHours: 0.5,
    meetingCount: 1,
    soloBlockCount: 0,
    averageDurationMinutes: 30,
    backToBackPct: 0,
    topAttendees: [{ display: "Nick Hoxsie", count: 1 }],
    weeklySeries: [{ weekStartIso: "2026-04-19T00:00:00Z", hours: 0.5, count: 1 }],
    dayOfWeekDistribution: [0, 0, 1, 0, 0, 0, 0],
  },
  suggestions: [
    {
      id: "ok_weekly_hours",
      severity: "info",
      headline: "Weekly meeting load is sustainable (0.5h avg)",
      detail: "You have room for deep-work blocks.",
    },
  ],
};

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
});

describe("CalendarPage", () => {
  test("loads week view on mount + renders insights + suggestions", async () => {
    mockRange(SAMPLE);
    render(<CalendarPage />);
    await waitFor(() =>
      expect(screen.getByTestId("calendar-page")).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("calendar-loading")).toBeNull(),
    );
    expect(screen.getByTestId("suggestion-ok_weekly_hours")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-top-contacts")).toHaveTextContent("Nick Hoxsie");
    expect(screen.getByTestId("calendar-weekly-series")).toBeInTheDocument();
    const calls = mockFetchWithRefresh.mock.calls.map((c) => c[0] as string);
    expect(calls.some((u) => u.includes("/api/calendar/range") && u.includes("view=week"))).toBe(true);
  });

  test("switching to Month fires view_changed analytics + refetches", async () => {
    mockRange(SAMPLE);
    render(<CalendarPage />);
    await waitFor(() =>
      expect(screen.getByTestId("calendar-page")).toBeInTheDocument(),
    );
    // Re-mock with month
    mockRange({ ...SAMPLE, view: "month" });
    fireEvent.click(screen.getByTestId("calendar-view-month"));

    await waitFor(() => {
      const calls = mockFetchWithRefresh.mock.calls.map((c) => c[0] as string);
      expect(calls.some((u) => u.includes("view=month"))).toBe(true);
    });
    const analyticsCall = mockFetchWithRefresh.mock.calls.find(
      (c) => c[0] === "/api/analytics" && JSON.parse(c[1].body).event === "calendar.view_changed",
    );
    expect(analyticsCall).toBeTruthy();
  });

  test("fires calendar.page_viewed on mount and suggestion_viewed per suggestion", async () => {
    mockRange(SAMPLE);
    render(<CalendarPage />);
    await waitFor(() =>
      expect(screen.getByTestId("calendar-page")).toBeInTheDocument(),
    );
    await waitFor(() => {
      const events = mockFetchWithRefresh.mock.calls
        .filter((c) => c[0] === "/api/analytics")
        .map((c) => JSON.parse(c[1].body).event);
      expect(events).toContain("calendar.page_viewed");
      expect(events).toContain("calendar.suggestion_viewed");
    });
  });

  test("renders error state on non-ok response", async () => {
    mockRange({}, 500);
    render(<CalendarPage />);
    await waitFor(() =>
      expect(screen.getByTestId("calendar-error")).toBeInTheDocument(),
    );
  });

  test("hides entirely on 403 (restricted)", async () => {
    mockRange({}, 403);
    const { container } = render(<CalendarPage />);
    await waitFor(() => {
      expect(screen.queryByTestId("calendar-loading")).toBeNull();
    });
    expect(container.innerHTML).toBe("");
  });
});

describe("CalendarPage — week grid integration", () => {
  test("week view renders the grid above the analytics dashboard with the sample event", async () => {
    mockRange({
      ...SAMPLE,
      events: [
        {
          ...SAMPLE.events[0],
          // Force into the visible window: 10am local on a Sun-anchored
          // week; Apr 21 2026 is a Tuesday → day idx 2.
          start: "2026-04-21T10:00:00",
          end: "2026-04-21T11:00:00",
          subject: "Admin Access",
        },
      ],
    });
    render(<CalendarPage />);
    await waitFor(() =>
      expect(screen.getByTestId("calendar-week-grid")).toBeInTheDocument(),
    );
    // Event card lives inside the week grid AND in the flat list.
    expect(screen.getByTestId("calendar-week-event-e1")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-event-e1")).toBeInTheDocument();
  });

  test("clicking a grid event opens the brief panel in the flat list (single source of truth)", async () => {
    // jsdom doesn't implement scrollIntoView. The page calls it
    // inside requestAnimationFrame after the click — stub it so the
    // rAF callback doesn't throw.
    (Element.prototype as any).scrollIntoView = () => {};

    mockRange({
      ...SAMPLE,
      events: [
        {
          ...SAMPLE.events[0],
          start: "2026-04-21T10:00:00",
          end: "2026-04-21T11:00:00",
        },
      ],
    });
    render(<CalendarPage />);
    await waitFor(() =>
      expect(screen.getByTestId("calendar-week-grid")).toBeInTheDocument(),
    );
    const callsBefore = mockFetchWithRefresh.mock.calls.length;
    fireEvent.click(screen.getByTestId("calendar-week-event-e1"));
    // Match on body content directly so the assertion is robust to
    // event-shape drift; the page POSTs /api/analytics with a body
    // that tags the brief-open as coming from the week_grid.
    await waitFor(() => {
      const newCalls = mockFetchWithRefresh.mock.calls
        .slice(callsBefore)
        .filter((c) => c[0] === "/api/analytics");
      const matched = newCalls.find((c) => {
        const body = String(c[1]?.body ?? "");
        return (
          body.includes("calendar.meeting_brief_opened") &&
          body.includes("week_grid") &&
          body.includes("e1")
        );
      });
      expect(matched).toBeTruthy();
    });
  });

  test("non-week views (month/year) do NOT render the grid", async () => {
    mockRange(SAMPLE);
    render(<CalendarPage />);
    await waitFor(() =>
      expect(screen.getByTestId("calendar-week-grid")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("calendar-view-month"));
    await waitFor(() => {
      expect(screen.queryByTestId("calendar-week-grid")).toBeNull();
    });
  });
});
