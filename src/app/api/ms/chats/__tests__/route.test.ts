/**
 * API: GET /api/ms/chats + GET /api/ms/chats/[id].
 * Covers 401 (no JWT), 200 (happy path), 403 (non-member), scope_missing,
 * and 500 paths.
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

const mockListChatsResult = jest.fn();
const mockGetChat = jest.fn();
const mockGetChatMessagesResult = jest.fn();
jest.mock("@/lib/ms-graph-chats", () => ({
  listChatsResult: (...a: any[]) => mockListChatsResult(...a),
  getChat: (...a: any[]) => mockGetChat(...a),
  getChatMessagesResult: (...a: any[]) => mockGetChatMessagesResult(...a),
}));

function mkReq(path: string, auth?: string): any {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return new Request(`http://test${path}`, { method: "GET", headers }) as any;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// GET /api/ms/chats
// ---------------------------------------------------------------------------

describe("GET /api/ms/chats", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const { GET } = await import("@/app/api/ms/chats/route");
    const res = await GET(mkReq("/api/ms/chats"));
    expect(res.status).toBe(401);
  });

  it("200 { chats: [], connected: false } when no MS token", async () => {
    mockGetUser.mockReturnValue({ id: "u1", email: "a@x.com", role: "dev" });
    mockGetValidToken.mockResolvedValue(null);
    const { GET } = await import("@/app/api/ms/chats/route");
    const res = await GET(mkReq("/api/ms/chats", "Bearer token"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ chats: [], connected: false });
  });

  it("200 with chats on happy path", async () => {
    mockGetUser.mockReturnValue({ id: "u1", email: "a@x.com", role: "dev" });
    mockGetValidToken.mockResolvedValue({ accessToken: "T", userEmail: "a@x.com" });
    mockListChatsResult.mockResolvedValue({
      ok: true,
      chats: [{ id: "c1", topic: "hi", chatType: "group", lastUpdatedDateTime: "", members: [] }],
    });

    const { GET } = await import("@/app/api/ms/chats/route");
    const res = await GET(mkReq("/api/ms/chats", "Bearer token"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.chats).toHaveLength(1);
  });

  it("includes self_email from the MS token so the UI can identify the caller in Graph terms", async () => {
    // Regression: Instinct session email (e.g. cto@wolfpack.dev)
    // differs from the MS identity (e.g. homyk@thewolfpack.agency — the
    // CTO's real Graph login). The UI needs the MS identity to filter
    // "self" out of each chat's members array; otherwise every 1:1
    // chat renders the caller's own name as the title.
    mockGetUser.mockReturnValue({ id: "u1", email: "cto@wolfpack.dev", role: "cto" });
    mockGetValidToken.mockResolvedValue({
      accessToken: "T",
      userEmail: "homyk@thewolfpack.agency",
    });
    mockListChatsResult.mockResolvedValue({ ok: true, chats: [] });

    const { GET } = await import("@/app/api/ms/chats/route");
    const res = await GET(mkReq("/api/ms/chats", "Bearer token"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.self_email).toBe("homyk@thewolfpack.agency");
  });

  it("200 { scope_missing: true } when lib returns scope_missing", async () => {
    mockGetUser.mockReturnValue({ id: "u1", email: "a@x.com", role: "dev" });
    mockGetValidToken.mockResolvedValue({ accessToken: "T", userEmail: "a@x.com" });
    mockListChatsResult.mockResolvedValue({
      ok: false,
      code: "scope_missing",
      scope: "Chat.Read",
    });

    const { GET } = await import("@/app/api/ms/chats/route");
    const res = await GET(mkReq("/api/ms/chats", "Bearer token"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ chats: [], scope_missing: true });
  });

  it("500 when the lib throws unexpectedly", async () => {
    mockGetUser.mockReturnValue({ id: "u1", email: "a@x.com", role: "dev" });
    mockGetValidToken.mockResolvedValue({ accessToken: "T", userEmail: "a@x.com" });
    mockListChatsResult.mockRejectedValue(new Error("boom"));
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await import("@/app/api/ms/chats/route");
    const res = await GET(mkReq("/api/ms/chats", "Bearer token"));
    expect(res.status).toBe(500);
    err.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// GET /api/ms/chats/[id]
// ---------------------------------------------------------------------------

describe("GET /api/ms/chats/[id]", () => {
  const CALLER = { id: "u1", email: "caller@x.com", role: "dev" };

  function loadRoute() {
    return import("@/app/api/ms/chats/[id]/route");
  }
  function ctx(id: string) {
    return { params: Promise.resolve({ id }) };
  }

  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const { GET } = await loadRoute();
    const res = await GET(mkReq("/api/ms/chats/c1"), ctx("c1"));
    expect(res.status).toBe(401);
  });

  it("200 { messages: [], connected: false } when no MS token", async () => {
    mockGetUser.mockReturnValue(CALLER);
    mockGetValidToken.mockResolvedValue(null);
    const { GET } = await loadRoute();
    const res = await GET(mkReq("/api/ms/chats/c1"), ctx("c1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connected).toBe(false);
  });

  it("200 { scope_missing: true } when chat meta fetch hits scope_missing", async () => {
    mockGetUser.mockReturnValue(CALLER);
    mockGetValidToken.mockResolvedValue({ accessToken: "T", userEmail: "caller@x.com" });
    mockGetChat.mockResolvedValue({ ok: false, code: "scope_missing", scope: "Chat.Read" });
    const { GET } = await loadRoute();
    const res = await GET(mkReq("/api/ms/chats/c1"), ctx("c1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope_missing).toBe(true);
  });

  it("404 when chat not found", async () => {
    mockGetUser.mockReturnValue(CALLER);
    mockGetValidToken.mockResolvedValue({ accessToken: "T", userEmail: "caller@x.com" });
    mockGetChat.mockResolvedValue({ ok: false, code: "not_found" });
    const { GET } = await loadRoute();
    const res = await GET(mkReq("/api/ms/chats/c1"), ctx("c1"));
    expect(res.status).toBe(404);
  });

  it("403 when caller is NOT in members list", async () => {
    mockGetUser.mockReturnValue(CALLER);
    mockGetValidToken.mockResolvedValue({ accessToken: "T", userEmail: "caller@x.com" });
    mockGetChat.mockResolvedValue({
      ok: true,
      chat: {
        id: "c1",
        topic: "t",
        chatType: "group",
        lastUpdatedDateTime: "",
        members: [
          { displayName: "Alice", email: "alice@x.com", userId: "u-a" },
          { displayName: "Bob", email: "bob@x.com", userId: "u-b" },
        ],
      },
    });
    const { GET } = await loadRoute();
    const res = await GET(mkReq("/api/ms/chats/c1"), ctx("c1"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/member/i);
  });

  it("200 messages when caller IS a member", async () => {
    mockGetUser.mockReturnValue(CALLER);
    mockGetValidToken.mockResolvedValue({ accessToken: "T", userEmail: "caller@x.com" });
    mockGetChat.mockResolvedValue({
      ok: true,
      chat: {
        id: "c1",
        topic: "t",
        chatType: "group",
        lastUpdatedDateTime: "",
        members: [
          { displayName: "Caller", email: "caller@x.com", userId: "u-caller" },
        ],
      },
    });
    mockGetChatMessagesResult.mockResolvedValue({
      ok: true,
      messages: [
        {
          id: "m1",
          from: { displayName: "Caller", email: "caller@x.com", userId: "u-caller" },
          body: { content: "hi", contentType: "text" },
          bodyText: "hi",
          createdDateTime: "2026-04-22T12:00:00Z",
        },
      ],
    });
    const { GET } = await loadRoute();
    const res = await GET(mkReq("/api/ms/chats/c1"), ctx("c1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toHaveLength(1);
  });

  it("500 when an unexpected error bubbles", async () => {
    mockGetUser.mockReturnValue(CALLER);
    mockGetValidToken.mockResolvedValue({ accessToken: "T", userEmail: "caller@x.com" });
    mockGetChat.mockRejectedValue(new Error("boom"));
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await loadRoute();
    const res = await GET(mkReq("/api/ms/chats/c1"), ctx("c1"));
    expect(res.status).toBe(500);
    err.mockRestore();
  });
});
