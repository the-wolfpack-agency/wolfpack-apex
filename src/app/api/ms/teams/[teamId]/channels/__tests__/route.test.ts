/**
 * API: GET /api/ms/teams/[teamId]/channels
 */
 
export {};

const mockGetUser = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: any[]) => mockGetUser(...a),
}));

const mockGetValidToken = jest.fn();
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...a: any[]) => mockGetValidToken(...a),
}));

const mockListTeamChannels = jest.fn();
jest.mock("@/lib/ms-graph-teams", () => ({
  listJoinedTeams: jest.fn(),
  listTeamChannels: (...a: any[]) => mockListTeamChannels(...a),
  listChannelMessages: jest.fn(),
}));

function mkReq(path: string, auth?: string): any {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return new Request(`http://test${path}`, { method: "GET", headers }) as any;
}

beforeEach(() => jest.clearAllMocks());

describe("GET /api/ms/teams/[teamId]/channels", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const { GET } = await import("@/app/api/ms/teams/[teamId]/channels/route");
    const res = await GET(mkReq("/api/ms/teams/t1/channels"), {
      params: Promise.resolve({ teamId: "t1" }),
    });
    expect(res.status).toBe(401);
  });

  it("200 happy path returns channels", async () => {
    mockGetUser.mockReturnValue({ id: "u1" });
    mockGetValidToken.mockResolvedValue({ accessToken: "ms-tok" });
    mockListTeamChannels.mockResolvedValue({
      ok: true,
      channels: [
        { id: "c1", displayName: "General" },
        { id: "c2", displayName: "Engineering" },
      ],
    });
    const { GET } = await import("@/app/api/ms/teams/[teamId]/channels/route");
    const res = await GET(mkReq("/api/ms/teams/t1/channels", "Bearer t"), {
      params: Promise.resolve({ teamId: "t1" }),
    });
    const body = await res.json();
    expect(body.channels).toHaveLength(2);
    expect(mockListTeamChannels.mock.calls[0][1]).toBe("t1");
  });

  it("200 scope_missing surfaces", async () => {
    mockGetUser.mockReturnValue({ id: "u1" });
    mockGetValidToken.mockResolvedValue({ accessToken: "ms-tok" });
    mockListTeamChannels.mockResolvedValue({
      ok: false,
      code: "scope_missing",
      scope: "Channel.ReadBasic.All",
    });
    const { GET } = await import("@/app/api/ms/teams/[teamId]/channels/route");
    const res = await GET(mkReq("/api/ms/teams/t1/channels", "Bearer t"), {
      params: Promise.resolve({ teamId: "t1" }),
    });
    const body = await res.json();
    expect(body.scope_missing).toBe(true);
    expect(body.channels).toEqual([]);
  });
});
