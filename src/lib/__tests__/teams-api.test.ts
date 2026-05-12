/**
 * /api/teams route tests — auth, rate limit, 403 scope_missing, analytics.
 */
 

const mockGetUser = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...args: unknown[]) => mockGetUser(...args),
}));

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrack(...args),
}));

const mockListCachedChats = jest.fn();
const mockGetCachedChatById = jest.fn();
const mockListCachedMessages = jest.fn();
const mockSyncAllForUser = jest.fn();
const mockAsScopeMissing = jest.fn();

class FakeTeamsChatError extends Error {
  status: number;
  retryAfter?: number;
  constructor(status: number, msg: string, retryAfter?: number) {
    super(msg);
    this.name = "TeamsChatError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

jest.mock("@/lib/integrations/microsoft-teams-chat", () => ({
  listCachedChats: (...args: unknown[]) => mockListCachedChats(...args),
  getCachedChatById: (...args: unknown[]) => mockGetCachedChatById(...args),
  listCachedMessages: (...args: unknown[]) => mockListCachedMessages(...args),
  syncAllForUser: (...args: unknown[]) => mockSyncAllForUser(...args),
  asScopeMissing: (...args: unknown[]) => mockAsScopeMissing(...args),
  TeamsChatError: FakeTeamsChatError,
}));

jest.mock("@/lib/db", () => ({
  safeQuery: jest.fn(),
  query: jest.fn(),
}));

import { GET as chatsGET } from "@/app/api/teams/chats/route";
import { GET as messagesGET } from "@/app/api/teams/chats/[id]/messages/route";
import { POST as syncPOST, _resetRateLimit as resetTeamsRate } from "@/app/api/teams/sync/route";

function mkReq(opts: { auth?: string; body?: unknown; url?: string; method?: string } = {}) {
  const headers = new Headers();
  if (opts.auth) headers.set("authorization", opts.auth);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return new Request(opts.url ?? "http://test/api/teams/chats", {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  }) as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetTeamsRate();
  mockAsScopeMissing.mockReturnValue(null);
});

// ---------------------------------------------------------------------------
// GET /api/teams/chats
// ---------------------------------------------------------------------------

describe("GET /api/teams/chats", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await chatsGET(mkReq());
    expect(res.status).toBe(401);
  });

  it("returns chats from cache", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockListCachedChats.mockResolvedValue({ chats: [{ id: "c1" }], nextCursor: null });
    const res = await chatsGET(mkReq({ auth: "Bearer x" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.chats).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// GET /api/teams/chats/[id]/messages
// ---------------------------------------------------------------------------

describe("GET /api/teams/chats/[id]/messages", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await messagesGET(mkReq(), { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(401);
  });

  it("404 when chat not in cache", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockGetCachedChatById.mockResolvedValue(null);
    const res = await messagesGET(mkReq({ auth: "Bearer x" }), { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(404);
  });

  it("returns chat + messages with nextCursor", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockGetCachedChatById.mockResolvedValue({ id: "c1", msChatId: "ms-c1" });
    mockListCachedMessages.mockResolvedValue({
      messages: [{ id: "m1" }],
      nextCursor: "m1",
    });
    const res = await messagesGET(
      mkReq({ auth: "Bearer x", url: "http://test/api/teams/chats/c1/messages?search=budget" }),
      { params: Promise.resolve({ id: "c1" }) },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.chat).toBeDefined();
    expect(data.messages).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// POST /api/teams/sync
// ---------------------------------------------------------------------------

describe("POST /api/teams/sync", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await syncPOST(mkReq({ method: "POST" }));
    expect(res.status).toBe(401);
  });

  it("runs sync and returns result", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockSyncAllForUser.mockResolvedValue({ chatCount: 3, messageCount: 20, durationMs: 100 });
    const res = await syncPOST(mkReq({ method: "POST", auth: "Bearer x" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.chatCount).toBe(3);
  });

  it("429 when rate-limited", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockSyncAllForUser.mockResolvedValue({ chatCount: 0, messageCount: 0, durationMs: 1 });
    await syncPOST(mkReq({ method: "POST", auth: "Bearer x" }));
    const res = await syncPOST(mkReq({ method: "POST", auth: "Bearer x" }));
    expect(res.status).toBe(429);
    expect(mockTrack).toHaveBeenCalledWith(
      "system.upload_rate_limited",
      "u",
      "cto",
      expect.objectContaining({ endpoint: "teams/sync" }),
    );
  });

  it("403 when scope_missing", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    const err = new FakeTeamsChatError(403, "no scope");
    mockSyncAllForUser.mockRejectedValue(err);
    mockAsScopeMissing.mockReturnValueOnce({ ok: false, code: "scope_missing", scope: "Chat.Read" });
    const res = await syncPOST(mkReq({ method: "POST", auth: "Bearer x" }));
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.code).toBe("scope_missing");
  });

  it("401 when MS not connected", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockSyncAllForUser.mockRejectedValue(new FakeTeamsChatError(401, "no token"));
    const res = await syncPOST(mkReq({ method: "POST", auth: "Bearer x" }));
    expect(res.status).toBe(401);
  });

  it("502 on graph 5xx", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockSyncAllForUser.mockRejectedValue(new FakeTeamsChatError(500, "boom"));
    const res = await syncPOST(mkReq({ method: "POST", auth: "Bearer x" }));
    expect(res.status).toBe(502);
  });
});
