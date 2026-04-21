/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * GET /api/meetings/prebrief/[id]
 *
 * Locks the contract the dashboard tile relies on:
 *   - 401 when requireCapability rejects (missing/invalid bearer)
 *   - 404 when the meeting isn't in the caller's calendar
 *   - 200 returning the computed shape
 *   - fires meeting.prebrief_computed analytics on success
 */

const mockCompute = jest.fn();
const mockRequireCapability = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/meetings/prebrief", () => ({
  computePrebrief: (...a: any[]) => mockCompute(...a),
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

function req(): NextRequest {
  return new NextRequest("https://x.test/api/meetings/prebrief/evt-1", {
    method: "GET",
    headers: { authorization: "Bearer x" },
  });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  mockCompute.mockReset();
  mockRequireCapability.mockReset();
  mockTrackEvent.mockReset();
});

describe("GET /api/meetings/prebrief/[id]", () => {
  test("401 when requireCapability rejects the caller", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    });
    const res = await GET(req(), ctx("evt-1"));
    expect(res.status).toBe(401);
    expect(mockCompute).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  test("404 when computePrebrief returns null (meeting not found)", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: USER, capabilities: new Set() });
    mockCompute.mockResolvedValue(null);
    const res = await GET(req(), ctx("missing"));
    expect(res.status).toBe(404);
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  test("200 happy path returns the computed shape and fires analytics", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: USER, capabilities: new Set() });
    const payload = {
      meeting: {
        id: "evt-1",
        subject: "Q2 Review",
        start: "2026-04-21T14:00:00Z",
        end: "2026-04-21T15:00:00Z",
        location: "Teams",
        attendees: ["james@greenfield.com"],
        isOnlineMeeting: true,
      },
      attendeeEmails: ["james@greenfield.com"],
      recentThreads: [],
      openTasks: [],
      linkedGoal: null,
      decisionSnippet: null,
    };
    mockCompute.mockResolvedValue(payload);

    const res = await GET(req(), ctx("evt-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meeting.id).toBe("evt-1");
    expect(body.attendeeEmails).toEqual(["james@greenfield.com"]);
    expect(body.linkedGoal).toBeNull();

    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
    const [evt, uid, role, meta] = mockTrackEvent.mock.calls[0];
    expect(evt).toBe("meeting.prebrief_computed");
    expect(uid).toBe(USER.id);
    expect(role).toBe(USER.role);
    expect(meta.meeting_id).toBe("evt-1");
    expect(meta.attendee_count).toBe(1);
    expect(meta.has_linked_goal).toBe(false);
  });

  test("passes the authenticated user id into computePrebrief", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: USER, capabilities: new Set() });
    mockCompute.mockResolvedValue({
      meeting: {
        id: "evt-2",
        subject: "x",
        start: "",
        end: "",
        location: "",
        attendees: [],
        isOnlineMeeting: false,
      },
      attendeeEmails: [],
      recentThreads: [],
      openTasks: [],
      linkedGoal: null,
      decisionSnippet: null,
    });
    await GET(req(), ctx("evt-2"));
    expect(mockCompute).toHaveBeenCalledWith(USER.id, "evt-2");
  });
});
