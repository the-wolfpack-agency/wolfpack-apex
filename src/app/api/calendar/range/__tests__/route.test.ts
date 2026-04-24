/* eslint-disable @typescript-eslint/no-explicit-any */
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

import { NextRequest, NextResponse } from "next/server";
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

describe("GET /api/calendar/range", () => {
  test("401 when requireCapability rejects", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    });
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  test("defaults to view=week when no query params present", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: USER, capabilities: new Set() });
    mockFetchCalendarEvents.mockResolvedValue([]);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.view).toBe("week");
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.insights).toBeDefined();
    expect(Array.isArray(body.suggestions)).toBe(true);
  });

  test("view=month fans the calendar fetch into multiple <=4-day windows", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: USER, capabilities: new Set() });
    mockFetchCalendarEvents.mockResolvedValue([]);
    await GET(req("https://x.test/api/calendar/range?view=month&ref=2026-04-15T00:00:00Z"));
    // ~30-day window in ≤4-day slices ≈ 8 calls.
    expect(mockFetchCalendarEvents.mock.calls.length).toBeGreaterThanOrEqual(7);
    for (const [, startIso, endIso] of mockFetchCalendarEvents.mock.calls) {
      const dur = Date.parse(endIso) - Date.parse(startIso);
      expect(dur).toBeLessThanOrEqual(4 * 24 * 60 * 60_000 + 1000);
    }
  });

  test("invalid view falls back to week (never throws)", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: USER, capabilities: new Set() });
    mockFetchCalendarEvents.mockResolvedValue([]);
    const res = await GET(req("https://x.test/api/calendar/range?view=decade"));
    const body = await res.json();
    expect(body.view).toBe("week");
  });

  test("dedupes events that straddle fan-out windows", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: USER, capabilities: new Set() });
    const shared = {
      id: "shared-1",
      subject: "Standup",
      start: "2026-04-21T10:00:00Z",
      end: "2026-04-21T10:30:00Z",
      location: "",
      attendees: ["Nick"],
      attendeeEmails: [],
      isOnlineMeeting: false,
    };
    mockFetchCalendarEvents.mockResolvedValue([shared]);
    const res = await GET(req("https://x.test/api/calendar/range?view=week&ref=2026-04-21T12:00:00Z"));
    const body = await res.json();
    expect(body.events.filter((e: any) => e.id === "shared-1")).toHaveLength(1);
  });

  test("fires calendar.range_computed analytics + Brain ingest", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: USER, capabilities: new Set() });
    mockFetchCalendarEvents.mockResolvedValue([]);
    await GET(req("https://x.test/api/calendar/range?view=year&ref=2026-06-01T00:00:00Z"));
    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
    const [evt, , , meta] = mockTrackEvent.mock.calls[0];
    expect(evt).toBe("calendar.range_computed");
    expect(meta.view).toBe("year");
    expect(mockIngest).toHaveBeenCalledTimes(1);
  });

  test("tolerates Graph failures gracefully (empty events, no throw)", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: USER, capabilities: new Set() });
    mockFetchCalendarEvents.mockRejectedValue(new Error("graph down"));
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toEqual([]);
    expect(body.insights.meetingCount).toBe(0);
  });

  test("returns events sorted descending by start (newest first)", async () => {
    // Regression: Nick called out "User has to scroll to the bottom
    // to find the latest". Graph returns events in roughly ascending
    // order; the route must sort descending so the most recent (or
    // next-up future) event sits at the top of the list.
    mockRequireCapability.mockResolvedValue({ ok: true, user: USER });
    mockFetchCalendarEvents.mockResolvedValue([
      { id: "old", subject: "April 20", start: "2026-04-20T10:00:00Z", end: "2026-04-20T11:00:00Z" },
      { id: "newest", subject: "April 23", start: "2026-04-23T10:00:00Z", end: "2026-04-23T11:00:00Z" },
      { id: "middle", subject: "April 21", start: "2026-04-21T10:00:00Z", end: "2026-04-21T11:00:00Z" },
    ]);
    const res = await GET(req());
    const body = await res.json();
    const ids = (body.events as { id: string }[]).map((e) => e.id);
    expect(ids).toEqual(["newest", "middle", "old"]);
  });
});
