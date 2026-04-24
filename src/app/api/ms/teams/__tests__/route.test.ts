/**
 * API: GET /api/ms/teams — list joined Teams. Mirrors the auth +
 * proxy contract of /api/ms/chats. Covers 401, 200 happy, scope_missing,
 * not connected, and 500.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export {};

const mockGetUser = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: any[]) => mockGetUser(...a),
}));

const mockGetValidToken = jest.fn();
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...a: any[]) => mockGetValidToken(...a),
}));

const mockListJoinedTeams = jest.fn();
jest.mock("@/lib/ms-graph-teams", () => ({
  listJoinedTeams: (...a: any[]) => mockListJoinedTeams(...a),
  listTeamChannels: jest.fn(),
  listChannelMessages: jest.fn(),
}));

function mkReq(path: string, auth?: string): any {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return new Request(`http://test${path}`, { method: "GET", headers }) as any;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /api/ms/teams", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const { GET } = await import("@/app/api/ms/teams/route");
    const res = await GET(mkReq("/api/ms/teams"));
    expect(res.status).toBe(401);
  });

  it("200 connected:false when no MS token", async () => {
    mockGetUser.mockReturnValue({ id: "u1" });
    mockGetValidToken.mockResolvedValue(null);
    const { GET } = await import("@/app/api/ms/teams/route");
    const res = await GET(mkReq("/api/ms/teams", "Bearer t"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ teams: [], connected: false });
  });

  it("200 happy path returns teams", async () => {
    mockGetUser.mockReturnValue({ id: "u1" });
    mockGetValidToken.mockResolvedValue({ accessToken: "ms-tok" });
    mockListJoinedTeams.mockResolvedValue({
      ok: true,
      teams: [
        { id: "t1", displayName: "Wolfpack Internal" },
        { id: "t2", displayName: "CFTR" },
      ],
    });
    const { GET } = await import("@/app/api/ms/teams/route");
    const res = await GET(mkReq("/api/ms/teams", "Bearer t"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.teams).toHaveLength(2);
    expect(body.teams[0].displayName).toBe("Wolfpack Internal");
  });

  it("200 scope_missing:true when graph returned 403", async () => {
    mockGetUser.mockReturnValue({ id: "u1" });
    mockGetValidToken.mockResolvedValue({ accessToken: "ms-tok" });
    mockListJoinedTeams.mockResolvedValue({
      ok: false,
      code: "scope_missing",
      scope: "Team.ReadBasic.All",
    });
    const { GET } = await import("@/app/api/ms/teams/route");
    const res = await GET(mkReq("/api/ms/teams", "Bearer t"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope_missing).toBe(true);
    expect(body.teams).toEqual([]);
  });

  it("200 graph_error:true when helper returns code=error (e.g. 400 from Graph)", async () => {
    mockGetUser.mockReturnValue({ id: "u1" });
    mockGetValidToken.mockResolvedValue({ accessToken: "ms-tok" });
    mockListJoinedTeams.mockResolvedValue({ ok: false, code: "error", status: 400 });
    const { GET } = await import("@/app/api/ms/teams/route");
    const res = await GET(mkReq("/api/ms/teams", "Bearer t"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.graph_error).toBe(true);
    expect(body.graph_status).toBe(400);
    expect(body.teams).toEqual([]);
    // Critically: do NOT impersonate scope_missing, so the UI
    // doesn't tell the user the wrong corrective action.
    expect(body.scope_missing).toBeUndefined();
  });

  it("respects limit query param (clamped to 1..100)", async () => {
    mockGetUser.mockReturnValue({ id: "u1" });
    mockGetValidToken.mockResolvedValue({ accessToken: "ms-tok" });
    mockListJoinedTeams.mockResolvedValue({ ok: true, teams: [] });
    const { GET } = await import("@/app/api/ms/teams/route");
    await GET(mkReq("/api/ms/teams?limit=999", "Bearer t"));
    // Confirm clamped (max=100), not the literal 999.
    const callLimit = mockListJoinedTeams.mock.calls[0][1];
    expect(callLimit).toBeLessThanOrEqual(100);
  });

  it("500 on unexpected error", async () => {
    mockGetUser.mockReturnValue({ id: "u1" });
    mockGetValidToken.mockRejectedValue(new Error("boom"));
    const { GET } = await import("@/app/api/ms/teams/route");
    const res = await GET(mkReq("/api/ms/teams", "Bearer t"));
    expect(res.status).toBe(500);
  });
});
