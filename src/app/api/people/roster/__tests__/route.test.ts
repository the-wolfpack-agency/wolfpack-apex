/**
 * Contract for GET /api/people/roster.
 *
 * Locked behaviours:
 *   - 403 without hr.employees.view
 *   - 200 merges employees + members + invites into one list
 *   - 503 rather than an empty roster when the database is unreachable
 *   - scoped to the caller's workspace, not to every tenant
 *   - can_manage_access reflects the caller, and is only a rendering hint
 */

export {};

const mockRequireCap = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCap(...a),
}));

const mockListEmployees = jest.fn();
jest.mock("@/lib/people", () => ({ listEmployees: (...a: any[]) => mockListEmployees(...a) }));

const mockListMembers = jest.fn();
const mockListInvites = jest.fn();
jest.mock("@/lib/team/directory", () => ({
  listTeamMembers: (...a: any[]) => mockListMembers(...a),
  listPendingInvites: (...a: any[]) => mockListInvites(...a),
  pendingInvitesFor: jest.requireActual("@/lib/team/directory").pendingInvitesFor,
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: any[]) => mockTrackEvent(...a) }));

import { GET } from "../route";

const HR_USER = { id: "u_hr", email: "hr@wolfpack.test", role: "hr", workspaceId: "ws_1" };

function allow(user = HR_USER, caps: string[] = ["hr.employees.view"]) {
  mockRequireCap.mockResolvedValue({ ok: true, user, capabilities: new Set(caps) });
}

const req: any = { headers: new Headers() };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DATABASE_URL = "postgresql://test";
  mockListEmployees.mockResolvedValue([]);
  mockListMembers.mockResolvedValue({ rows: [], degraded: false });
  mockListInvites.mockResolvedValue({ rows: [], degraded: false });
});

describe("authorization", () => {
  it("403s without hr.employees.view", async () => {
    const denied = new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    mockRequireCap.mockResolvedValue({ ok: false, response: denied });
    expect((await GET(req)).status).toBe(403);
    expect(mockListMembers).not.toHaveBeenCalled();
  });

  it("gates on hr.employees.view, the same capability as the list it replaces", async () => {
    allow();
    await GET(req);
    expect(mockRequireCap).toHaveBeenCalledWith(req, "hr.employees.view");
  });
});

describe("the merged roster", () => {
  it("returns people who have an account but no employee record", async () => {
    // The whole point: this person was invisible on /hr before.
    allow();
    mockListMembers.mockResolvedValue({
      rows: [
        {
          id: "m1",
          email: "new@wolfpack.test",
          name: "Newcomer",
          role: "ops",
          is_active: true,
          created_at: "2026-07-01T00:00:00Z",
          last_login: null,
          has_password: true,
          m365_connected: false,
        },
      ],
      degraded: false,
    });
    const body = await (await GET(req)).json();
    expect(body.roster).toHaveLength(1);
    expect(body.roster[0]).toMatchObject({ member_id: "m1", employee_id: null, access: "active" });
    expect(body.summary).toMatchObject({ total: 1, active: 1 });
  });

  it("drops an invite that the person already accepted", async () => {
    allow();
    mockListMembers.mockResolvedValue({
      rows: [
        {
          id: "m1",
          email: "both@wolfpack.test",
          name: "Both",
          role: "ops",
          is_active: true,
          created_at: "2026-07-01T00:00:00Z",
          last_login: null,
          has_password: true,
          m365_connected: false,
        },
      ],
      degraded: false,
    });
    mockListInvites.mockResolvedValue({
      rows: [
        { id: "i1", email: "both@wolfpack.test", role: "ops", invited_by: "u", created_at: "2026-07-01T00:00:00Z", expires_at: null },
      ],
      degraded: false,
    });
    const body = await (await GET(req)).json();
    expect(body.roster).toHaveLength(1);
    expect(body.roster[0].access).toBe("active");
  });

  it("records the view for the learning loop", async () => {
    allow();
    await GET(req);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "hr.roster_viewed",
      "u_hr",
      "hr",
      expect.objectContaining({ total: 0 }),
    );
  });
});

describe("tenancy", () => {
  it("reads only the caller's workspace", async () => {
    // An unscoped enumeration of the identity tables would hand one tenant
    // another tenant's roster.
    allow({ ...HR_USER, workspaceId: "ws_other" });
    await GET(req);
    expect(mockListMembers).toHaveBeenCalledWith("ws_other");
    expect(mockListInvites).toHaveBeenCalledWith("ws_other");
  });
});

describe("when the database is unreachable", () => {
  it("503s instead of reporting that nobody has access", async () => {
    // An empty roster is a confident, wrong answer that somebody would act on.
    allow();
    mockListMembers.mockResolvedValue({ rows: [], degraded: true });
    const res = await GET(req);
    expect(res.status).toBe(503);
  });

  it("503s if the invites read degraded too", async () => {
    allow();
    mockListInvites.mockResolvedValue({ rows: [], degraded: true });
    expect((await GET(req)).status).toBe(503);
  });
});

describe("can_manage_access", () => {
  it("is false for HR, who may see access but not change it", async () => {
    allow(HR_USER, ["hr.employees.view"]);
    const body = await (await GET(req)).json();
    expect(body.can_manage_access).toBe(false);
  });

  it("is true for someone holding settings.manage_team", async () => {
    allow({ ...HR_USER, role: "cto" }, ["hr.employees.view", "settings.manage_team"]);
    const body = await (await GET(req)).json();
    expect(body.can_manage_access).toBe(true);
  });
});
