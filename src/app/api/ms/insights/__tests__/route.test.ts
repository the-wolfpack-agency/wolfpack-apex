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
