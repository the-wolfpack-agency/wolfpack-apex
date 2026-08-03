/**
 * Contract for GET /api/admin/team-status.
 *
 * The route had no tests. It was refactored onto the shared
 * src/lib/team/directory reader so it and the /hr roster cannot drift into two
 * different answers to "who has access", and a refactor of an untested route is
 * a refactor nobody can check. These pin the derived flags it reports, which is
 * everything the route actually adds on top of the shared read.
 */

export {};

const mockRequireCap = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCap(...a),
}));

const mockListMembers = jest.fn();
const mockListInvites = jest.fn();
jest.mock("@/lib/team/directory", () => ({
  listTeamMembers: (...a: any[]) => mockListMembers(...a),
  listPendingInvites: (...a: any[]) => mockListInvites(...a),
  pendingInvitesFor: jest.requireActual("@/lib/team/directory").pendingInvitesFor,
}));

import { GET } from "../route";

const CTO = { id: "u_cto", email: "cto@wolfpack.test", role: "cto", workspaceId: "ws_1" };
const req: any = { headers: new Headers() };

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const member = (o: Record<string, unknown>) => ({
  id: "m1",
  email: "a@wolfpack.test",
  name: "A",
  role: "ops",
  is_active: true,
  created_at: iso(30 * 24 * HOUR),
  last_login: null,
  has_password: true,
  m365_connected: false,
  ...o,
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DATABASE_URL = "postgresql://test";
  mockRequireCap.mockResolvedValue({ ok: true, user: CTO, capabilities: new Set(["settings.manage_team"]) });
  mockListMembers.mockResolvedValue({ rows: [], degraded: false });
  mockListInvites.mockResolvedValue({ rows: [], degraded: false });
});

describe("authorization and tenancy", () => {
  it("403s without settings.manage_team", async () => {
    const denied = new Response("{}", { status: 403 });
    mockRequireCap.mockResolvedValue({ ok: false, response: denied });
    expect((await GET(req)).status).toBe(403);
    expect(mockListMembers).not.toHaveBeenCalled();
  });

  it("reads only the caller's workspace", async () => {
    await GET(req);
    expect(mockListMembers).toHaveBeenCalledWith("ws_1");
    expect(mockListInvites).toHaveBeenCalledWith("ws_1");
  });

  it("503s rather than reporting an empty team when the database is unreachable", async () => {
    mockListMembers.mockResolvedValue({ rows: [], degraded: true });
    expect((await GET(req)).status).toBe(503);
  });
});

describe("derived flags", () => {
  it("counts somebody with a password as accepted, even with no login yet", async () => {
    mockListMembers.mockResolvedValue({ rows: [member({ has_password: true, last_login: null })], degraded: false });
    const body = await (await GET(req)).json();
    expect(body.members[0].accepted).toBe(true);
  });

  it("counts somebody with a login but no password as accepted too", async () => {
    // Signed in through Microsoft OAuth: no local password, but plainly in.
    mockListMembers.mockResolvedValue({
      rows: [member({ has_password: false, last_login: iso(2 * HOUR) })],
      degraded: false,
    });
    const body = await (await GET(req)).json();
    expect(body.members[0].accepted).toBe(true);
  });

  it("does not count a half-provisioned row as accepted", async () => {
    mockListMembers.mockResolvedValue({
      rows: [member({ has_password: false, last_login: null })],
      degraded: false,
    });
    const body = await (await GET(req)).json();
    expect(body.members[0].accepted).toBe(false);
  });

  it("marks a sign-in within the last 15 minutes as recently active", async () => {
    mockListMembers.mockResolvedValue({ rows: [member({ last_login: iso(5 * MIN) })], degraded: false });
    const body = await (await GET(req)).json();
    expect(body.members[0].recently_active).toBe(true);
  });

  it("does not mark an hour-old sign-in as recently active", async () => {
    mockListMembers.mockResolvedValue({ rows: [member({ last_login: iso(2 * HOUR) })], degraded: false });
    const body = await (await GET(req)).json();
    expect(body.members[0].recently_active).toBe(false);
  });

  it("marks a member created in the last day as newly onboarded", async () => {
    mockListMembers.mockResolvedValue({ rows: [member({ created_at: iso(2 * HOUR) })], degraded: false });
    const body = await (await GET(req)).json();
    expect(body.members[0].newly_onboarded).toBe(true);
  });
});

describe("pending invites", () => {
  it("hides an invite whose address already has an account", async () => {
    mockListMembers.mockResolvedValue({ rows: [member({ email: "both@wolfpack.test" })], degraded: false });
    mockListInvites.mockResolvedValue({
      rows: [{ id: "i1", email: "both@wolfpack.test", role: "ops", invited_by: "u", created_at: iso(HOUR), expires_at: null }],
      degraded: false,
    });
    const body = await (await GET(req)).json();
    expect(body.pending_invites).toHaveLength(0);
    expect(body.summary.pending_invites).toBe(0);
  });

  it("reports an outstanding invite with how long it has been waiting", async () => {
    mockListInvites.mockResolvedValue({
      rows: [{ id: "i1", email: "new@wolfpack.test", role: "ops", invited_by: "u", created_at: iso(3 * HOUR), expires_at: null }],
      degraded: false,
    });
    const body = await (await GET(req)).json();
    expect(body.pending_invites).toHaveLength(1);
    expect(body.pending_invites[0].hours_pending).toBe(3);
  });
});

describe("summary", () => {
  it("totals each flag across the members", async () => {
    mockListMembers.mockResolvedValue({
      rows: [
        member({ id: "m1", email: "a@wolfpack.test", last_login: iso(MIN), m365_connected: true }),
        member({ id: "m2", email: "b@wolfpack.test", has_password: false, last_login: null }),
      ],
      degraded: false,
    });
    const body = await (await GET(req)).json();
    expect(body.summary).toMatchObject({
      total_members: 2,
      accepted: 1,
      recently_active: 1,
      m365_connected: 1,
    });
  });
});
