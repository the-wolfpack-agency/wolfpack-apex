/**
 * API: GET /api/ms/teams/[teamId]/channels/[channelId]/messages
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

const mockListChannelMessages = jest.fn();
const mockSendChannelMessage = jest.fn();
jest.mock("@/lib/ms-graph-teams", () => ({
  listJoinedTeams: jest.fn(),
  listTeamChannels: jest.fn(),
  listChannelMessages: (...a: any[]) => mockListChannelMessages(...a),
  sendChannelMessage: (...a: any[]) => mockSendChannelMessage(...a),
}));

function mkReq(path: string, auth?: string): any {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return new Request(`http://test${path}`, { method: "GET", headers }) as any;
}

beforeEach(() => jest.clearAllMocks());

describe("GET /api/ms/teams/[teamId]/channels/[channelId]/messages", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const { GET } = await import(
      "@/app/api/ms/teams/[teamId]/channels/[channelId]/messages/route"
    );
    const res = await GET(mkReq("/api/ms/teams/t/channels/c/messages"), {
      params: Promise.resolve({ teamId: "t", channelId: "c" }),
    });
    expect(res.status).toBe(401);
  });

  it("200 happy path returns messages", async () => {
    mockGetUser.mockReturnValue({ id: "u1" });
    mockGetValidToken.mockResolvedValue({ accessToken: "ms-tok" });
    mockListChannelMessages.mockResolvedValue({
      ok: true,
      messages: [
        {
          id: "m1",
          createdDateTime: "2026-04-23T10:00:00Z",
          body: { contentType: "text", content: "hi" },
          bodyText: "hi",
        },
      ],
    });
    const { GET } = await import(
      "@/app/api/ms/teams/[teamId]/channels/[channelId]/messages/route"
    );
    const res = await GET(
      mkReq("/api/ms/teams/t/channels/c/messages", "Bearer t"),
      { params: Promise.resolve({ teamId: "t", channelId: "c" }) },
    );
    const body = await res.json();
    expect(body.messages).toHaveLength(1);
    expect(mockListChannelMessages.mock.calls[0][1]).toBe("t");
    expect(mockListChannelMessages.mock.calls[0][2]).toBe("c");
  });

  it("200 scope_missing surfaces", async () => {
    mockGetUser.mockReturnValue({ id: "u1" });
    mockGetValidToken.mockResolvedValue({ accessToken: "ms-tok" });
    mockListChannelMessages.mockResolvedValue({
      ok: false,
      code: "scope_missing",
      scope: "ChannelMessage.Read.All",
    });
    const { GET } = await import(
      "@/app/api/ms/teams/[teamId]/channels/[channelId]/messages/route"
    );
    const res = await GET(
      mkReq("/api/ms/teams/t/channels/c/messages", "Bearer t"),
      { params: Promise.resolve({ teamId: "t", channelId: "c" }) },
    );
    const body = await res.json();
    expect(body.scope_missing).toBe(true);
    expect(body.messages).toEqual([]);
  });
});

describe("POST /api/ms/teams/[teamId]/channels/[channelId]/messages", () => {
  function postReq(body: any, auth = "Bearer t"): any {
    const headers = new Headers();
    if (auth) headers.set("authorization", auth);
    headers.set("content-type", "application/json");
    return new Request("http://test/api/ms/teams/t/channels/c/messages", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }) as any;
  }

  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const { POST } = await import(
      "@/app/api/ms/teams/[teamId]/channels/[channelId]/messages/route"
    );
    const res = await POST(postReq({ content: "hi" }, ""), {
      params: Promise.resolve({ teamId: "t", channelId: "c" }),
    });
    expect(res.status).toBe(401);
  });

  it("400 when content missing or empty", async () => {
    mockGetUser.mockReturnValue({ id: "u1" });
    const { POST } = await import(
      "@/app/api/ms/teams/[teamId]/channels/[channelId]/messages/route"
    );
    const res = await POST(postReq({ content: "  " }), {
      params: Promise.resolve({ teamId: "t", channelId: "c" }),
    });
    expect(res.status).toBe(400);
  });

  it("happy path returns the server message", async () => {
    mockGetUser.mockReturnValue({ id: "u1" });
    mockGetValidToken.mockResolvedValue({ accessToken: "ms-tok" });
    mockSendChannelMessage.mockResolvedValue({
      ok: true,
      message: {
        id: "srv-1",
        createdDateTime: "2026-04-24T10:00:00Z",
        body: { contentType: "text", content: "hi" },
        bodyText: "hi",
      },
    });
    const { POST } = await import(
      "@/app/api/ms/teams/[teamId]/channels/[channelId]/messages/route"
    );
    const res = await POST(postReq({ content: "hi" }), {
      params: Promise.resolve({ teamId: "t", channelId: "c" }),
    });
    const body = await res.json();
    expect(body.message.id).toBe("srv-1");
    expect(mockSendChannelMessage.mock.calls[0][3]).toBe("hi");
  });

  it("scope_missing surfaces", async () => {
    mockGetUser.mockReturnValue({ id: "u1" });
    mockGetValidToken.mockResolvedValue({ accessToken: "ms-tok" });
    mockSendChannelMessage.mockResolvedValue({
      ok: false,
      code: "scope_missing",
      scope: "ChannelMessage.Send",
    });
    const { POST } = await import(
      "@/app/api/ms/teams/[teamId]/channels/[channelId]/messages/route"
    );
    const res = await POST(postReq({ content: "hi" }), {
      params: Promise.resolve({ teamId: "t", channelId: "c" }),
    });
    const body = await res.json();
    expect(body.scope_missing).toBe(true);
  });

  it("graph_error surfaces with status + code + message", async () => {
    mockGetUser.mockReturnValue({ id: "u1" });
    mockGetValidToken.mockResolvedValue({ accessToken: "ms-tok" });
    mockSendChannelMessage.mockResolvedValue({
      ok: false,
      code: "error",
      status: 403,
      graphCode: "Forbidden",
      graphMessage: "User not in channel",
    });
    const { POST } = await import(
      "@/app/api/ms/teams/[teamId]/channels/[channelId]/messages/route"
    );
    const body = await (
      await POST(postReq({ content: "hi" }), {
        params: Promise.resolve({ teamId: "t", channelId: "c" }),
      })
    ).json();
    expect(body.graph_error).toBe(true);
    expect(body.graph_status).toBe(403);
    expect(body.graph_code).toBe("Forbidden");
  });
});
