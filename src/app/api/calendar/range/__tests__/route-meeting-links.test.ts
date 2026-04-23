/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * /api/calendar/range — verifies that `webLink` and `onlineMeeting.joinUrl`
 * from Microsoft Graph pass through verbatim so the /calendar UI can
 * render Outlook and Teams deep links.
 */
const mockRequireCapability = jest.fn();
const mockTrackEvent = jest.fn();
const mockFetchCalendarEvents = jest.fn();
const mockIngest = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/microsoft-graph", () => ({
  fetchCalendarEvents: (...a: any[]) => mockFetchCalendarEvents(...a),
}));
jest.mock("@/lib/brain/ingest-insights", () => ({
  ingestCalendarRangeToBrain: (...a: any[]) => mockIngest(...a),
}));

import { NextRequest } from "next/server";
import { GET } from "../route";

const USER = { id: "u1", role: "ceo", name: "Nick", email: "n@x.co", created_at: "" };

function req(url = "https://x.test/api/calendar/range") {
  return new NextRequest(url, { method: "GET", headers: { authorization: "Bearer x" } });
}

beforeEach(() => {
  mockRequireCapability.mockReset();
  mockTrackEvent.mockReset();
  mockFetchCalendarEvents.mockReset();
  mockIngest.mockReset();
});

test("GET /api/calendar/range returns 200 and preserves webLink + joinUrl on events", async () => {
  mockRequireCapability.mockResolvedValue({ ok: true, user: USER, capabilities: new Set() });
  mockFetchCalendarEvents.mockResolvedValue([
    {
      id: "ev-1",
      subject: "Graph standup",
      start: "2026-04-21T10:00:00Z",
      end: "2026-04-21T10:30:00Z",
      location: "",
      attendees: ["Nick"],
      attendeeEmails: [],
      isOnlineMeeting: true,
      webLink: "https://outlook.office.com/calendar/item/ev-1",
      joinUrl: "https://teams.microsoft.com/l/meetup-join/ev-1",
    },
  ]);
  const res = await GET(req("https://x.test/api/calendar/range?view=week&ref=2026-04-21T12:00:00Z"));
  expect(res.status).toBe(200);
  const body = await res.json();
  const ev = body.events.find((e: any) => e.id === "ev-1");
  expect(ev).toBeDefined();
  expect(ev.webLink).toBe("https://outlook.office.com/calendar/item/ev-1");
  expect(ev.joinUrl).toBe("https://teams.microsoft.com/l/meetup-join/ev-1");
});

test("events without onlineMeeting still return 200 with null join url", async () => {
  mockRequireCapability.mockResolvedValue({ ok: true, user: USER, capabilities: new Set() });
  mockFetchCalendarEvents.mockResolvedValue([
    {
      id: "ev-2",
      subject: "Lunch",
      start: "2026-04-21T12:00:00Z",
      end: "2026-04-21T13:00:00Z",
      location: "Bistro",
      attendees: ["A"],
      attendeeEmails: [],
      isOnlineMeeting: false,
      webLink: "https://outlook.office.com/calendar/item/ev-2",
      joinUrl: null,
    },
  ]);
  const res = await GET(req("https://x.test/api/calendar/range?view=week"));
  expect(res.status).toBe(200);
  const body = await res.json();
  const ev = body.events.find((e: any) => e.id === "ev-2");
  expect(ev.joinUrl).toBeNull();
  expect(ev.webLink).toContain("outlook.office.com");
});
