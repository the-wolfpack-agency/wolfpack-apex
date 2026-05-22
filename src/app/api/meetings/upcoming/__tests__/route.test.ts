 
/**
 * GET /api/meetings/upcoming
 *
 * Locks the contract the dashboard prebrief panel relies on:
 *   - 401 when requireCapability rejects
 *   - 200 returns { meetings: [...] } with the listUpcoming result
 *   - passes clamped hours/lookback/limit into listUpcomingMeetings
 *   - fires meeting.upcoming_fetched analytics on success
 */

const mockList = jest.fn();
const mockRequireCapability = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/meetings/upcoming", () => ({
  listUpcomingMeetings: (...a: any[]) => mockList(...a),
}));
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));

import { NextRequest, NextResponse } from "next/server";
import { GET } from "../route";

const USER = { id: "u1", role: "ceo", name: "Nick", email: "n@x.co", created_at: "" };

function req(url = "https://x.test/api/meetings/upcoming"): NextRequest {
  return new NextRequest(url, {
    method: "GET",
    headers: { authorization: "Bearer x" },
  });
}

beforeEach(() => {
  mockList.mockReset();
  mockRequireCapability.mockReset();
  mockTrackEvent.mockReset();
});

describe("GET /api/meetings/upcoming", () => {
  test("401 when requireCapability rejects", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    });
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  test("200 returns the listUpcoming result wrapped in { meetings }", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: USER, capabilities: new Set() });
    const payload = [
      {
        id: "evt-1",
        subject: "Q2 Review",
        start: "2026-04-21T14:00:00Z",
        end: "2026-04-21T15:00:00Z",
        location: "Teams",
        attendees: ["a@b.co"],
        isOnlineMeeting: true,
        minutesUntil: 180,
        inProgress: false,
      },
    ];
    mockList.mockResolvedValue(payload);

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meetings).toEqual(payload);
    expect(mockList).toHaveBeenCalledWith(USER.id, {
      lookaheadHours: 48,
      lookbackMinutes: 30,
      limit: 20,
    });
  });

  test("clamps query params into valid ranges and passes through", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: USER, capabilities: new Set() });
    mockList.mockResolvedValue([]);
    // hours=500 → clamped to 168, lookback=-10 → 0, limit=999 → 50
    await GET(req("https://x.test/api/meetings/upcoming?hours=500&lookback=-10&limit=999"));
    expect(mockList).toHaveBeenCalledWith(USER.id, {
      lookaheadHours: 168,
      lookbackMinutes: 0,
      limit: 50,
    });
  });

  test("rejects NaN inputs by falling back to defaults", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: USER, capabilities: new Set() });
    mockList.mockResolvedValue([]);
    await GET(req("https://x.test/api/meetings/upcoming?hours=abc&lookback=nope&limit=xyz"));
    expect(mockList).toHaveBeenCalledWith(USER.id, {
      lookaheadHours: 48,
      lookbackMinutes: 30,
      limit: 20,
    });
  });

  test("fires meeting.upcoming_fetched analytics with count + in_progress_count", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: USER, capabilities: new Set() });
    mockList.mockResolvedValue([
      { id: "a", subject: "A", start: "", end: "", location: "", attendees: [], isOnlineMeeting: false, minutesUntil: 10, inProgress: false, isOutOfOffice: false },
      { id: "b", subject: "B", start: "", end: "", location: "", attendees: [], isOnlineMeeting: false, minutesUntil: -2, inProgress: true, isOutOfOffice: false },
    ]);
    await GET(req("https://x.test/api/meetings/upcoming?hours=24"));
    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
    const [evt, uid, role, meta] = mockTrackEvent.mock.calls[0];
    expect(evt).toBe("meeting.upcoming_fetched");
    expect(uid).toBe(USER.id);
    expect(role).toBe(USER.role);
    expect(meta.count).toBe(2);
    expect(meta.in_progress_count).toBe(1);
    expect(meta.lookahead_hours).toBe(24);
    expect(meta.lookback_minutes).toBe(30);
  });

  test("splits OOO entries into outOfOffice envelope, leaving meetings free of noise", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: USER, capabilities: new Set() });
    mockList.mockResolvedValue([
      { id: "m1", subject: "Q2 Review", start: "", end: "", location: "", attendees: [], isOnlineMeeting: false, minutesUntil: 60, inProgress: false, isOutOfOffice: false },
      { id: "o1", subject: "Ashley OOO", start: "", end: "", location: "", attendees: [], isOnlineMeeting: false, minutesUntil: 0, inProgress: true, isOutOfOffice: true },
      { id: "o2", subject: "Hoxsie OoO", start: "", end: "", location: "", attendees: [], isOnlineMeeting: false, minutesUntil: 0, inProgress: true, isOutOfOffice: true },
    ]);
    const res = await GET(req());
    const body = await res.json();
    expect(body.meetings.map((m: { id: string }) => m.id)).toEqual(["m1"]);
    expect(body.outOfOffice.map((m: { id: string }) => m.id)).toEqual(["o1", "o2"]);
  });

  test("analytics includes out_of_office_count", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: USER, capabilities: new Set() });
    mockList.mockResolvedValue([
      { id: "m1", subject: "Real meeting", start: "", end: "", location: "", attendees: [], isOnlineMeeting: false, minutesUntil: 60, inProgress: false, isOutOfOffice: false },
      { id: "o1", subject: "Ashley PTO", start: "", end: "", location: "", attendees: [], isOnlineMeeting: false, minutesUntil: 0, inProgress: false, isOutOfOffice: true },
    ]);
    await GET(req());
    const [, , , meta] = mockTrackEvent.mock.calls[0];
    expect(meta.count).toBe(1);
    expect(meta.out_of_office_count).toBe(1);
  });

  test("when every entry is OOO, meetings is empty and outOfOffice carries them all", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: USER, capabilities: new Set() });
    mockList.mockResolvedValue([
      { id: "o1", subject: "Ashley OOO", start: "", end: "", location: "", attendees: [], isOnlineMeeting: false, minutesUntil: 0, inProgress: true, isOutOfOffice: true },
      { id: "o2", subject: "Hoxsie Vacation", start: "", end: "", location: "", attendees: [], isOnlineMeeting: false, minutesUntil: 0, inProgress: true, isOutOfOffice: true },
    ]);
    const res = await GET(req());
    const body = await res.json();
    expect(body.meetings).toEqual([]);
    expect(body.outOfOffice).toHaveLength(2);
  });
});
