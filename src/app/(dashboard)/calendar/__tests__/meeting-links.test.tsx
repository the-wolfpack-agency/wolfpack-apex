/** @jest-environment jsdom */
 
import "@testing-library/jest-dom";

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  authHeaders: () => ({ Authorization: "Bearer x" }),
  jsonHeaders: () => ({ "Content-Type": "application/json", Authorization: "Bearer x" }),
}));

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CalendarPage from "@/app/(dashboard)/calendar/page";

const PAYLOAD_WITH_LINKS = {
  view: "week",
  range: { startIso: "2026-04-19T00:00:00Z", endIso: "2026-04-25T23:59:59Z" },
  events: [
    {
      id: "ev-with-both",
      subject: "Client Sync",
      start: "2026-04-21T10:30:00Z",
      end: "2026-04-21T11:00:00Z",
      location: "Teams",
      attendees: ["A"],
      webLink: "https://outlook.office.com/calendar/item/1",
      joinUrl: "https://teams.microsoft.com/l/meetup-join/1",
    },
    {
      id: "ev-web-only",
      subject: "Lunch",
      start: "2026-04-21T12:00:00Z",
      end: "2026-04-21T13:00:00Z",
      location: "Bistro",
      attendees: ["B"],
      webLink: "https://outlook.office.com/calendar/item/2",
      joinUrl: null,
    },
    {
      id: "ev-no-links",
      subject: "Offline planning",
      start: "2026-04-21T14:00:00Z",
      end: "2026-04-21T15:00:00Z",
      location: "",
      attendees: [],
    },
  ],
  insights: {
    totalMeetingHours: 1.5,
    meetingCount: 3,
    soloBlockCount: 0,
    averageDurationMinutes: 30,
    backToBackPct: 0,
    topAttendees: [],
    weeklySeries: [],
    dayOfWeekDistribution: [0, 0, 3, 0, 0, 0, 0],
  },
  suggestions: [],
};

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  mockFetchWithRefresh.mockImplementation((url: string) => {
    if (typeof url === "string" && url.startsWith("/api/calendar/range")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => PAYLOAD_WITH_LINKS });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  });
});

test("subject renders as webLink anchor when Graph returned one (HTTP 200 path)", async () => {
  render(<CalendarPage />);
  await waitFor(() =>
    expect(screen.queryByTestId("calendar-loading")).toBeNull(),
  );

  const subjectLink = screen.getByTestId("calendar-event-weblink-ev-with-both");
  expect(subjectLink).toHaveAttribute("href", "https://outlook.office.com/calendar/item/1");
  expect(subjectLink).toHaveAttribute("target", "_blank");
  expect(subjectLink).toHaveAttribute("rel", expect.stringContaining("noopener"));

  // Join button only when onlineMeeting.joinUrl is present.
  expect(screen.getByTestId("calendar-event-joinurl-ev-with-both")).toHaveAttribute(
    "href",
    "https://teams.microsoft.com/l/meetup-join/1",
  );
});

test("webLink-only event still linkable; no Join button when joinUrl is missing", async () => {
  render(<CalendarPage />);
  await waitFor(() =>
    expect(screen.queryByTestId("calendar-loading")).toBeNull(),
  );
  expect(screen.getByTestId("calendar-event-weblink-ev-web-only")).toBeInTheDocument();
  expect(screen.queryByTestId("calendar-event-joinurl-ev-web-only")).toBeNull();
});

test("falls back to plain <p> subject when both webLink and joinUrl missing (no broken link)", async () => {
  render(<CalendarPage />);
  await waitFor(() =>
    expect(screen.queryByTestId("calendar-loading")).toBeNull(),
  );
  expect(screen.queryByTestId("calendar-event-weblink-ev-no-links")).toBeNull();
  expect(screen.queryByTestId("calendar-event-joinurl-ev-no-links")).toBeNull();
  expect(screen.getByTestId("calendar-event-ev-no-links")).toHaveTextContent("Offline planning");
});

test("clicking the subject fires calendar.meeting_opened_external with target=web", async () => {
  render(<CalendarPage />);
  await waitFor(() =>
    expect(screen.queryByTestId("calendar-loading")).toBeNull(),
  );

  fireEvent.click(screen.getByTestId("calendar-event-weblink-ev-with-both"));

  const call = mockFetchWithRefresh.mock.calls.find(
    (c) => c[0] === "/api/analytics" && JSON.parse(c[1].body).event === "calendar.meeting_opened_external",
  );
  expect(call).toBeTruthy();
  expect(JSON.parse(call![1].body).metadata.target).toBe("web");
});

test("clicking Join fires calendar.meeting_opened_external with target=join", async () => {
  render(<CalendarPage />);
  await waitFor(() =>
    expect(screen.queryByTestId("calendar-loading")).toBeNull(),
  );

  fireEvent.click(screen.getByTestId("calendar-event-joinurl-ev-with-both"));

  const call = mockFetchWithRefresh.mock.calls.find(
    (c) => c[0] === "/api/analytics" && JSON.parse(c[1].body).event === "calendar.meeting_opened_external",
  );
  expect(call).toBeTruthy();
  expect(JSON.parse(call![1].body).metadata.target).toBe("join");
});
