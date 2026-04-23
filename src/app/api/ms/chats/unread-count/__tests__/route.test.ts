/**
 * API: GET /api/ms/chats/unread-count.
 *
 * Covers:
 *   - 401 without auth
 *   - connected:false when no MS token
 *   - scope_missing passthrough
 *   - first-poll (no ?since=) returns 0 even with fresh chats
 *   - filters chats whose lastUpdatedDateTime > since
 *   - malformed ?since= is treated as "first poll"
 *   - 500 on unexpected throw
 *   - analytics event `messages.unread_count_polled` fires on every
 *     resolved path (happy, connected:false, scope_missing)
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
jest.mock("@/lib/ms-graph-chats", () => ({
  listChatsResult: (...a: any[]) => mockListChatsResult(...a),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));

function mkReq(path: string, auth?: string): any {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return new Request(`http://test${path}`, { method: "GET", headers }) as any;
}

const USER = { id: "u1", email: "a@x.com", role: "dev" };

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /api/ms/chats/unread-count", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const { GET } = await import("@/app/api/ms/chats/unread-count/route");
    const res = await GET(mkReq("/api/ms/chats/unread-count"));
    expect(res.status).toBe(401);
  });

  it("200 { count:0, connected:false } when no MS token + fires analytics", async () => {
    mockGetUser.mockReturnValue(USER);
    mockGetValidToken.mockResolvedValue(null);

    const { GET } = await import("@/app/api/ms/chats/unread-count/route");
    const res = await GET(mkReq("/api/ms/chats/unread-count", "Bearer t"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ count: 0, connected: false });

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "messages.unread_count_polled",
      "u1",
      "dev",
      expect.objectContaining({ count: 0, connected: false }),
    );
  });

  it("200 { count:0, scope_missing:true } when lib reports scope_missing + fires analytics", async () => {
    mockGetUser.mockReturnValue(USER);
    mockGetValidToken.mockResolvedValue({ accessToken: "T", userEmail: "a@x.com" });
    mockListChatsResult.mockResolvedValue({
      ok: false,
      code: "scope_missing",
      scope: "Chat.Read",
    });

    const { GET } = await import("@/app/api/ms/chats/unread-count/route");
    const res = await GET(mkReq("/api/ms/chats/unread-count", "Bearer t"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ count: 0, scope_missing: true });

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "messages.unread_count_polled",
      "u1",
      "dev",
      expect.objectContaining({ count: 0, scope_missing: true }),
    );
  });

  it("first poll (no ?since=) returns 0 even when there are fresh chats", async () => {
    mockGetUser.mockReturnValue(USER);
    mockGetValidToken.mockResolvedValue({ accessToken: "T", userEmail: "a@x.com" });
    mockListChatsResult.mockResolvedValue({
      ok: true,
      chats: [
        { id: "c1", topic: "", chatType: "group", lastUpdatedDateTime: "2030-01-01T00:00:00Z", members: [] },
        { id: "c2", topic: "", chatType: "group", lastUpdatedDateTime: "2030-01-02T00:00:00Z", members: [] },
      ],
    });

    const { GET } = await import("@/app/api/ms/chats/unread-count/route");
    const res = await GET(mkReq("/api/ms/chats/unread-count", "Bearer t"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(0);
    expect(body.total_chats).toBe(2);
    expect(body.since).toBeNull();
  });

  it("counts only chats whose lastUpdatedDateTime > since", async () => {
    mockGetUser.mockReturnValue(USER);
    mockGetValidToken.mockResolvedValue({ accessToken: "T", userEmail: "a@x.com" });
    mockListChatsResult.mockResolvedValue({
      ok: true,
      chats: [
        { id: "stale", topic: "", chatType: "group", lastUpdatedDateTime: "2026-04-20T00:00:00Z", members: [] },
        { id: "fresh1", topic: "", chatType: "group", lastUpdatedDateTime: "2026-04-23T10:00:00Z", members: [] },
        { id: "fresh2", topic: "", chatType: "group", lastUpdatedDateTime: "2026-04-23T12:00:00Z", members: [] },
        { id: "invalid", topic: "", chatType: "group", lastUpdatedDateTime: "not-a-date", members: [] },
      ],
    });

    const since = "2026-04-22T00:00:00Z";
    const { GET } = await import("@/app/api/ms/chats/unread-count/route");
    const res = await GET(
      mkReq(`/api/ms/chats/unread-count?since=${encodeURIComponent(since)}`, "Bearer t"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(2);
    expect(body.total_chats).toBe(4);
    expect(body.since).toBe(new Date(since).toISOString());

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "messages.unread_count_polled",
      "u1",
      "dev",
      expect.objectContaining({ count: 2, total_chats: 4, has_since: true }),
    );
  });

  it("malformed ?since= is treated as first poll (count 0)", async () => {
    mockGetUser.mockReturnValue(USER);
    mockGetValidToken.mockResolvedValue({ accessToken: "T", userEmail: "a@x.com" });
    mockListChatsResult.mockResolvedValue({
      ok: true,
      chats: [
        { id: "fresh", topic: "", chatType: "group", lastUpdatedDateTime: "2030-01-02T00:00:00Z", members: [] },
      ],
    });

    const { GET } = await import("@/app/api/ms/chats/unread-count/route");
    const res = await GET(mkReq("/api/ms/chats/unread-count?since=not-a-date", "Bearer t"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(0);
    expect(body.since).toBeNull();
  });

  it("500 when the lib throws unexpectedly", async () => {
    mockGetUser.mockReturnValue(USER);
    mockGetValidToken.mockResolvedValue({ accessToken: "T", userEmail: "a@x.com" });
    mockListChatsResult.mockRejectedValue(new Error("boom"));
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await import("@/app/api/ms/chats/unread-count/route");
    const res = await GET(mkReq("/api/ms/chats/unread-count", "Bearer t"));
    expect(res.status).toBe(500);
    err.mockRestore();
  });
});
