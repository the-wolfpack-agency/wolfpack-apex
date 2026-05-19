/**
 * Contract tests for GET /api/insights/meeting-prep.
 *
 * Asserts:
 *   - 401 when no auth
 *   - 400 when event_id is missing
 *   - 429 when the per-user rate limit is exceeded
 *   - 403 when force=1 but the caller isn't manager+
 *   - 200 + prep payload on a fresh synthesis
 *   - 200 + synthesis_unavailable + sources on synthesis failure
 *   - 404 when prepareMeeting returns null (meeting not in window)
 */

const mockRequireCapability = jest.fn();
const mockPrepareMeeting = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/insights/meeting-prep", () => ({
  prepareMeeting: (...a: unknown[]) => mockPrepareMeeting(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import { NextRequest } from "next/server";
import { GET, _resetRateLimit } from "@/app/api/insights/meeting-prep/route";

function makeReq(query: string, role = "cto"): NextRequest {
  void role; // role is set via the requireCapability mock
  return new NextRequest(`http://test/api/insights/meeting-prep${query}`, {
    method: "GET",
    headers: { authorization: "Bearer x" },
  });
}

function authOk(role = "cto") {
  return {
    ok: true,
    user: {
      id: "u1",
      role,
      email: "u1@test",
      name: "U",
      workspaceId: "ws-a",
      created_at: "",
    },
    capabilities: new Set(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimit();
});

describe("GET /api/insights/meeting-prep", () => {
  test("401 when auth fails", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: false,
      response: new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
      }),
    });
    const res = await GET(makeReq("?event_id=evt-1"));
    expect(res.status).toBe(401);
  });

  test("400 when event_id is missing", async () => {
    mockRequireCapability.mockResolvedValueOnce(authOk());
    const res = await GET(makeReq(""));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_input");
  });

  test("403 when force=1 but role is not manager+", async () => {
    mockRequireCapability.mockResolvedValueOnce(authOk("dev"));
    const res = await GET(makeReq("?event_id=evt-1&force=1"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("regenerate_role_required");
    expect(mockPrepareMeeting).not.toHaveBeenCalled();
  });

  test("200 + prep payload on a fresh synthesis", async () => {
    mockRequireCapability.mockResolvedValue(authOk());
    mockPrepareMeeting.mockResolvedValue({
      prep: {
        summary: "ok",
        goal: "ok",
        talking_points: [],
        risk_flags: [],
        attendee_briefs: [],
        open_questions: [],
      },
      sources: { event: { id: "evt-1" }, perAttendee: [], versionMarkers: {} },
      sourceHash: "abc",
      cacheStatus: "miss",
      generatedAt: "2026-05-19T00:00:00Z",
      synthesisUnavailable: false,
    });
    const res = await GET(makeReq("?event_id=evt-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cache_status).toBe("miss");
    expect(body.prep.summary).toBe("ok");
    expect(body.viewer_can_regenerate).toBe(true);
  });

  test("200 + synthesis_unavailable + raw sources on synthesis failure", async () => {
    mockRequireCapability.mockResolvedValue(authOk());
    mockPrepareMeeting.mockResolvedValue({
      prep: null,
      sources: { event: { id: "evt-1" }, perAttendee: [], versionMarkers: {} },
      sourceHash: "abc",
      cacheStatus: "miss",
      generatedAt: "2026-05-19T00:00:00Z",
      synthesisUnavailable: true,
      synthesisErrorCode: "invalid_json",
    });
    const res = await GET(makeReq("?event_id=evt-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.synthesis_unavailable).toBe(true);
    expect(body.sources).toBeDefined();
  });

  test("404 when prepareMeeting returns null", async () => {
    mockRequireCapability.mockResolvedValue(authOk());
    mockPrepareMeeting.mockResolvedValue(null);
    const res = await GET(makeReq("?event_id=missing"));
    expect(res.status).toBe(404);
  });

  test("rate limit: 6th request in 1 min returns 429", async () => {
    mockRequireCapability.mockResolvedValue(authOk());
    mockPrepareMeeting.mockResolvedValue({
      prep: {
        summary: "",
        goal: "",
        talking_points: [],
        risk_flags: [],
        attendee_briefs: [],
        open_questions: [],
      },
      sources: { event: {}, perAttendee: [], versionMarkers: {} },
      sourceHash: "abc",
      cacheStatus: "hit",
      generatedAt: "2026-05-19T00:00:00Z",
      synthesisUnavailable: false,
    });
    for (let i = 0; i < 5; i++) {
      const r = await GET(makeReq("?event_id=evt-1"));
      expect(r.status).toBe(200);
    }
    const sixth = await GET(makeReq("?event_id=evt-1"));
    expect(sixth.status).toBe(429);
    const body = await sixth.json();
    expect(body.error).toBe("rate_limited");
  });
});
