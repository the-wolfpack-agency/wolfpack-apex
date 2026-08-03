/**
 * Contract for POST /api/people/roster/[id]/access.
 *
 * This endpoint is the first thing in the codebase that ever WROTE
 * instinct_team_members.is_active. Every authenticated path reads it, so this
 * is the switch that decides whether somebody can sign in. The assertions that
 * matter are the refusals.
 *
 * Locked behaviours:
 *   - 403 without settings.manage_team (HR can see the roster, not change it)
 *   - 400 on a body that is not { active: boolean }
 *   - 400 refusing to remove your own access
 *   - 404 for a member of another workspace, with no hint that the id exists
 *   - 200 revoke and restore, each audited and tracked
 */

export {};

const mockRequireCap = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCap(...a),
}));

const mockSafeQuery = jest.fn();
const mockQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: any[]) => mockSafeQuery(...a),
  query: (...a: any[]) => mockQuery(...a),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: any[]) => mockTrackEvent(...a) }));

const mockRecordAudit = jest.fn();
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: any[]) => mockRecordAudit(...a),
  extractRequestMetadata: () => ({ ipAddress: "1.1.1.1", userAgent: "test", requestId: "r1" }),
}));

import { POST } from "../route";

const CTO = { id: "u_cto", email: "cto@wolfpack.test", role: "cto", workspaceId: "ws_1" };
const mkReq = (body: unknown): any => ({ json: async () => body, headers: new Headers() });
const mkParams = (id: string) => ({ params: Promise.resolve({ id }) });

/** An existing, currently-active member in the caller's workspace. */
function memberExists(overrides: Record<string, unknown> = {}) {
  mockSafeQuery.mockResolvedValue({
    rows: [{ email: "target@wolfpack.test", name: "Target", role: "ops", is_active: true, ...overrides }],
    fromCache: false,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DATABASE_URL = "postgresql://test";
  mockRequireCap.mockResolvedValue({ ok: true, user: CTO, capabilities: new Set(["settings.manage_team"]) });
  mockRecordAudit.mockResolvedValue(undefined);
  mockQuery.mockResolvedValue({ rowCount: 1 });
  memberExists();
});

describe("authorization", () => {
  it("403s without settings.manage_team", async () => {
    const denied = new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    mockRequireCap.mockResolvedValue({ ok: false, response: denied });
    const res = await POST(mkReq({ active: false }), mkParams("m1"));
    expect(res.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("requires settings.manage_team specifically, not an HR capability", async () => {
    await POST(mkReq({ active: false }), mkParams("m1"));
    expect(mockRequireCap).toHaveBeenCalledWith(expect.anything(), "settings.manage_team");
  });
});

describe("the body", () => {
  it.each([[{}], [{ active: "false" }], [{ active: 0 }], [null]])(
    "400s on %p and writes nothing",
    async (body) => {
      const res = await POST(mkReq(body), mkParams("m1"));
      expect(res.status).toBe(400);
      expect(mockQuery).not.toHaveBeenCalled();
    },
  );
});

describe("removing your own access", () => {
  it("400s, because it locks you out of the surface that would undo it", async () => {
    // And if you are the last administrator it locks everyone out.
    const res = await POST(mkReq({ active: false }), mkParams(CTO.id));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("your own access") });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("still allows restoring yourself", async () => {
    memberExists({ is_active: false });
    const res = await POST(mkReq({ active: true }), mkParams(CTO.id));
    expect(res.status).toBe(200);
  });
});

describe("finding the member", () => {
  it("404s when there is no such member", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
    expect((await POST(mkReq({ active: false }), mkParams("nope"))).status).toBe(404);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("scopes the lookup to the caller's workspace", async () => {
    // A member of another tenant must be indistinguishable from one that does
    // not exist, so the response is not a probe for valid ids.
    await POST(mkReq({ active: false }), mkParams("m1"));
    expect(mockSafeQuery.mock.calls[0][1]).toEqual(["m1", "ws_1"]);
  });

  it("scopes the write to the workspace as well", async () => {
    await POST(mkReq({ active: false }), mkParams("m1"));
    expect(mockQuery.mock.calls[0][1]).toEqual(["m1", false, "ws_1"]);
  });

  it("503s rather than guessing when the database is unreachable", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: true });
    expect((await POST(mkReq({ active: false }), mkParams("m1"))).status).toBe(503);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("revoking", () => {
  it("sets is_active false, the condition every auth path already checks", async () => {
    const res = await POST(mkReq({ active: false }), mkParams("m1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, active: false });
    expect(mockQuery.mock.calls[0][0]).toMatch(/UPDATE instinct_team_members/);
    expect(mockQuery.mock.calls[0][1][1]).toBe(false);
  });

  it("tracks and audits it, with the before and after state", async () => {
    await POST(mkReq({ active: false }), mkParams("m1"));
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "team.access_revoked",
      "u_cto",
      "cto",
      expect.objectContaining({ member_id: "m1" }),
    );
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admin.user.access_revoked",
        resourceType: "team_member",
        resourceId: "m1",
        beforeState: { is_active: true },
        afterState: { is_active: false },
      }),
    );
  });

  it("still succeeds when the audit write fails", async () => {
    // The access change has already committed. Reporting it as failed would
    // invite a second attempt against a state that already changed.
    mockRecordAudit.mockRejectedValue(new Error("chain unavailable"));
    expect((await POST(mkReq({ active: false }), mkParams("m1"))).status).toBe(200);
  });
});

describe("restoring", () => {
  it("reactivates without touching the password", async () => {
    // Somebody restored keeps whatever credential they had; if they have none
    // they go through the ordinary invite or reset path.
    memberExists({ is_active: false });
    const res = await POST(mkReq({ active: true }), mkParams("m1"));
    expect(res.status).toBe(200);
    expect(mockQuery.mock.calls[0][0]).not.toMatch(/password/i);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "team.access_restored",
      "u_cto",
      "cto",
      expect.anything(),
    );
  });
});

describe("a no-op", () => {
  it("reports unchanged and writes nothing when the state already matches", async () => {
    const res = await POST(mkReq({ active: true }), mkParams("m1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ unchanged: true });
    expect(mockQuery).not.toHaveBeenCalled();
    // No audit entry either: nothing happened, and a log of non-events is noise
    // in the one record that has to stay trustworthy.
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });
});
