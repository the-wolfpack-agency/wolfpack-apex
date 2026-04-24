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

function mkReq(auth?: string): any {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return new Request("http://test/api/ms/_debug", { method: "GET", headers }) as any;
}

function fakeJwt(scp: string, exp = Math.floor(Date.now() / 1000) + 600): string {
  const payload = Buffer.from(
    JSON.stringify({ scp, aud: "https://graph.microsoft.com", appid: "test-app", tid: "tnt", upn: "x@y.z", exp }),
  )
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
}

beforeEach(() => jest.clearAllMocks());

describe("GET /api/ms/_debug", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const { GET } = await import("@/app/api/ms/_debug/route");
    const res = await GET(mkReq());
    expect(res.status).toBe(401);
  });

  it("connected:false when no MS token stored", async () => {
    mockGetUser.mockReturnValue({ id: "u1" });
    mockGetValidToken.mockResolvedValue(null);
    const { GET } = await import("@/app/api/ms/_debug/route");
    const res = await GET(mkReq("Bearer t"));
    expect(await res.json()).toEqual({ connected: false });
  });

  it("returns missing_for_teams when token lacks Channel.ReadBasic.All", async () => {
    mockGetUser.mockReturnValue({ id: "u1" });
    mockGetValidToken.mockResolvedValue({
      accessToken: fakeJwt("Chat.Read Team.ReadBasic.All Mail.Read"),
    });
    const { GET } = await import("@/app/api/ms/_debug/route");
    const body = await (await GET(mkReq("Bearer t"))).json();
    expect(body.scopes).toContain("Team.ReadBasic.All");
    expect(body.scopes).not.toContain("Channel.ReadBasic.All");
    expect(body.missing_for_teams).toEqual(
      expect.arrayContaining(["Channel.ReadBasic.All", "ChannelMessage.Read.All"]),
    );
    expect(body.has_all_teams_scopes).toBe(false);
  });

  it("flags has_all_teams_scopes:true when token contains every expected scope", async () => {
    mockGetUser.mockReturnValue({ id: "u1" });
    mockGetValidToken.mockResolvedValue({
      accessToken: fakeJwt(
        "Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Read.All Chat.Read",
      ),
    });
    const { GET } = await import("@/app/api/ms/_debug/route");
    const body = await (await GET(mkReq("Bearer t"))).json();
    expect(body.has_all_teams_scopes).toBe(true);
    expect(body.missing_for_teams).toEqual([]);
  });

  it("decodable:false when token isn't a parseable JWS", async () => {
    mockGetUser.mockReturnValue({ id: "u1" });
    mockGetValidToken.mockResolvedValue({ accessToken: "not-a-jwt" });
    const { GET } = await import("@/app/api/ms/_debug/route");
    const body = await (await GET(mkReq("Bearer t"))).json();
    expect(body.decodable).toBe(false);
  });
});
