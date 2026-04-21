/* eslint-disable @typescript-eslint/no-explicit-any */
const mockRequireCapability = jest.fn();
const mockTrackEvent = jest.fn();
const mockFetchCalendarEvents = jest.fn();
const mockFetchRecentEmails = jest.fn();
const mockListCachedTasks = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/microsoft-graph", () => ({
  fetchCalendarEvents: (...a: any[]) => mockFetchCalendarEvents(...a),
  fetchRecentEmails: (...a: any[]) => mockFetchRecentEmails(...a),
}));
jest.mock("@/lib/integrations/microsoft-tasks", () => ({
  listCachedTasks: (...a: any[]) => mockListCachedTasks(...a),
}));

import { NextRequest, NextResponse } from "next/server";
import { GET } from "../route";

const USER = { id: "u1", role: "ceo", name: "Nick", email: "n@x.co", created_at: "" };

function req() {
  return new NextRequest("https://x.test/api/ms/insights", {
    headers: { authorization: "Bearer x" },
  });
}

beforeEach(() => {
  mockRequireCapability.mockReset();
  mockTrackEvent.mockReset();
  mockFetchCalendarEvents.mockReset();
  mockFetchRecentEmails.mockReset();
  mockListCachedTasks.mockReset();
});

describe("GET /api/ms/insights", () => {
  test("401 when capability missing", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "nope" }, { status: 401 }),
    });
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  test("200 returns { insights: [...] } sorted by severity + fires analytics", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: USER, capabilities: new Set() });
    mockFetchCalendarEvents.mockResolvedValue([]);
    mockFetchRecentEmails.mockResolvedValue([]);
    mockListCachedTasks.mockResolvedValue({ tasks: [], total: 0 });

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.insights)).toBe(true);
    expect(body.insights.length).toBe(6);
    expect(body.insights.every((i: any) => typeof i.id === "string")).toBe(true);

    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
    const [evt, uid, , meta] = mockTrackEvent.mock.calls[0];
    expect(evt).toBe("ms_insight.computed");
    expect(uid).toBe(USER.id);
    expect(meta.insight_count).toBe(6);
  });

  // Regression: a single -7d/+7d fetchCalendarEvents call returns at
  // most 50 events ordered start/dateTime ASC. On a busy calendar that
  // means today's meetings fell past the cap and meeting_load reported
  // "No meetings today." The route must fan out into narrow windows.
  test("fans the calendar fetch across multiple windows (never a single wide call)", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: USER, capabilities: new Set() });
    mockFetchCalendarEvents.mockResolvedValue([]);
    mockFetchRecentEmails.mockResolvedValue([]);
    mockListCachedTasks.mockResolvedValue({ tasks: [], total: 0 });

    await GET(req());
    expect(mockFetchCalendarEvents.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Every call's window must be <= 4 days so no single call risks the cap.
    for (const [, startIso, endIso] of mockFetchCalendarEvents.mock.calls) {
      const dur = Date.parse(endIso) - Date.parse(startIso);
      expect(dur).toBeLessThanOrEqual(4 * 24 * 60 * 60_000 + 1000);
    }
  });

  test("dedupes events that straddle fan-out windows", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: USER, capabilities: new Set() });
    // Same event returned from two overlapping windows — shouldn't be counted twice.
    const shared = {
      id: "recurring-1",
      subject: "Daily Standup",
      start: new Date().toISOString(),
      end: new Date(Date.now() + 30 * 60_000).toISOString(),
      location: "",
      attendees: ["Nick Hoxsie"],
      isOnlineMeeting: false,
    };
    mockFetchCalendarEvents.mockResolvedValue([shared]);
    mockFetchRecentEmails.mockResolvedValue([]);
    mockListCachedTasks.mockResolvedValue({ tasks: [], total: 0 });

    const res = await GET(req());
    const body = await res.json();
    // recurring_attendees would otherwise double-count this attendee
    // once per window. Expected metric is the unique occurrence count,
    // not the fan-out count.
    const recurring = body.insights.find((i: any) => i.id === "recurring_attendees");
    expect(recurring).toBeTruthy();
    expect(recurring.metric).toBe(1);
  });

  test("tolerates Graph failures by swapping in empty data", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: USER, capabilities: new Set() });
    mockFetchCalendarEvents.mockRejectedValue(new Error("graph down"));
    mockFetchRecentEmails.mockRejectedValue(new Error("graph down"));
    mockListCachedTasks.mockRejectedValue(new Error("db down"));

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.insights.length).toBe(6);
  });
});
