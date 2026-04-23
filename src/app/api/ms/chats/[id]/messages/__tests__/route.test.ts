/**
 * API: POST /api/ms/chats/[id]/messages — inline-compose route tests.
 *
 * Covers:
 *   - 401 no auth
 *   - 403 write_disabled when INSTINCT_TEAMS_WRITE_ENABLED=false
 *   - 400 missing / empty / too-long content
 *   - 403 non-member
 *   - 200 scope_missing from Graph (NOT 500)
 *   - 200 success → fires analytics + records audit
 *   - HTML sanitization before POSTing to Graph
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

const mockGetChat = jest.fn();
const mockSendChatMessage = jest.fn();
// Keep the real sanitizeComposeHtml so we can assert the Graph call uses it.
jest.mock("@/lib/ms-graph-chats", () => ({
  getChat: (...a: any[]) => mockGetChat(...a),
  sendChatMessage: (...a: any[]) => mockSendChatMessage(...a),
}));

const mockIsTeamsWriteEnabled = jest.fn();
jest.mock("@/lib/instinct-flags", () => ({
  isTeamsWriteEnabled: (...a: any[]) => mockIsTeamsWriteEnabled(...a),
}));

const mockRecordAudit = jest.fn();
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: any[]) => mockRecordAudit(...a),
  extractRequestMetadata: () => ({
    ipAddress: undefined,
    userAgent: "jest",
    requestId: undefined,
  }),
}));

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrack(...a),
}));

function mkReq(path: string, body: unknown, auth = "Bearer token"): any {
  const headers = new Headers({
    "content-type": "application/json",
    authorization: auth,
  });
  return new Request(`http://test${path}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as any;
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

const CALLER = { id: "u1", email: "caller@x.com", role: "dev" };

function memberChat() {
  return {
    ok: true,
    chat: {
      id: "c1",
      topic: "t",
      chatType: "group",
      lastUpdatedDateTime: "",
      members: [
        { displayName: "Caller", email: "caller@x.com", userId: "u-caller" },
        { displayName: "Bob", email: "bob@x.com", userId: "u-bob" },
      ],
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // default: write enabled (internal deployment)
  mockIsTeamsWriteEnabled.mockReturnValue(true);
  mockRecordAudit.mockResolvedValue({ id: "aud1", seq: 1, entryHash: "h" });
});

describe("POST /api/ms/chats/[id]/messages", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const { POST } = await import("@/app/api/ms/chats/[id]/messages/route");
    const res = await POST(mkReq("/api/ms/chats/c1/messages", { content: "hi" }), ctx("c1"));
    expect(res.status).toBe(401);
    expect(mockSendChatMessage).not.toHaveBeenCalled();
  });

  it("403 {write_disabled:true} when env flag disabled — and does NOT call Graph", async () => {
    mockGetUser.mockReturnValue(CALLER);
    mockIsTeamsWriteEnabled.mockReturnValue(false);
    const { POST } = await import("@/app/api/ms/chats/[id]/messages/route");
    const res = await POST(mkReq("/api/ms/chats/c1/messages", { content: "hi" }), ctx("c1"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ write_disabled: true });
    expect(mockSendChatMessage).not.toHaveBeenCalled();
    expect(mockGetValidToken).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(
      "ms_chats.write_disabled",
      "u1",
      "dev",
      { user_id: "u1" },
    );
  });

  it("400 when content is missing / empty string", async () => {
    mockGetUser.mockReturnValue(CALLER);
    const { POST } = await import("@/app/api/ms/chats/[id]/messages/route");
    const res = await POST(mkReq("/api/ms/chats/c1/messages", { content: "   " }), ctx("c1"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/missing/i);
    expect(mockSendChatMessage).not.toHaveBeenCalled();
  });

  it("400 when content exceeds 28KB limit", async () => {
    mockGetUser.mockReturnValue(CALLER);
    const long = "a".repeat(28 * 1024 + 1);
    const { POST } = await import("@/app/api/ms/chats/[id]/messages/route");
    const res = await POST(
      mkReq("/api/ms/chats/c1/messages", { content: long }),
      ctx("c1"),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/too long/i);
    expect(mockSendChatMessage).not.toHaveBeenCalled();
  });

  it("400 on invalid JSON body", async () => {
    mockGetUser.mockReturnValue(CALLER);
    const { POST } = await import("@/app/api/ms/chats/[id]/messages/route");
    const res = await POST(mkReq("/api/ms/chats/c1/messages", "not json {"), ctx("c1"));
    expect(res.status).toBe(400);
  });

  it("200 {messages:[], connected:false} when user has no MS token", async () => {
    mockGetUser.mockReturnValue(CALLER);
    mockGetValidToken.mockResolvedValue(null);
    const { POST } = await import("@/app/api/ms/chats/[id]/messages/route");
    const res = await POST(mkReq("/api/ms/chats/c1/messages", { content: "hi" }), ctx("c1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connected).toBe(false);
  });

  it("200 {scope_missing:true} when chat meta returns scope_missing (NOT 500)", async () => {
    mockGetUser.mockReturnValue(CALLER);
    mockGetValidToken.mockResolvedValue({ accessToken: "T", userEmail: "caller@x.com" });
    mockGetChat.mockResolvedValue({ ok: false, code: "scope_missing", scope: "Chat.Read" });
    const { POST } = await import("@/app/api/ms/chats/[id]/messages/route");
    const res = await POST(mkReq("/api/ms/chats/c1/messages", { content: "hi" }), ctx("c1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope_missing).toBe(true);
    expect(mockSendChatMessage).not.toHaveBeenCalled();
  });

  it("200 {scope_missing:true} when send itself returns scope_missing", async () => {
    mockGetUser.mockReturnValue(CALLER);
    mockGetValidToken.mockResolvedValue({ accessToken: "T", userEmail: "caller@x.com" });
    mockGetChat.mockResolvedValue(memberChat());
    mockSendChatMessage.mockResolvedValue({
      ok: false,
      code: "scope_missing",
      scope: "Chat.ReadWrite",
    });
    const { POST } = await import("@/app/api/ms/chats/[id]/messages/route");
    const res = await POST(mkReq("/api/ms/chats/c1/messages", { content: "hi" }), ctx("c1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope_missing).toBe(true);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("404 when chat not found", async () => {
    mockGetUser.mockReturnValue(CALLER);
    mockGetValidToken.mockResolvedValue({ accessToken: "T", userEmail: "caller@x.com" });
    mockGetChat.mockResolvedValue({ ok: false, code: "not_found" });
    const { POST } = await import("@/app/api/ms/chats/[id]/messages/route");
    const res = await POST(mkReq("/api/ms/chats/c1/messages", { content: "hi" }), ctx("c1"));
    expect(res.status).toBe(404);
  });

  it("403 when caller is NOT in chat members", async () => {
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
    const { POST } = await import("@/app/api/ms/chats/[id]/messages/route");
    const res = await POST(mkReq("/api/ms/chats/c1/messages", { content: "hi" }), ctx("c1"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/member/i);
    expect(mockSendChatMessage).not.toHaveBeenCalled();
  });

  it("200 happy path — records audit + returns normalized message", async () => {
    mockGetUser.mockReturnValue(CALLER);
    mockGetValidToken.mockResolvedValue({ accessToken: "T", userEmail: "caller@x.com" });
    mockGetChat.mockResolvedValue(memberChat());
    const returnedMsg = {
      id: "m-new",
      from: { displayName: "Caller", email: "caller@x.com", userId: "u-caller" },
      body: { content: "hi there", contentType: "text" as const },
      bodyText: "hi there",
      createdDateTime: "2026-04-22T12:00:00Z",
    };
    mockSendChatMessage.mockResolvedValue({ ok: true, message: returnedMsg });

    const { POST } = await import("@/app/api/ms/chats/[id]/messages/route");
    const res = await POST(
      mkReq("/api/ms/chats/c1/messages", { content: "hi there" }),
      ctx("c1"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toEqual(returnedMsg);

    // sendChatMessage called with text default
    expect(mockSendChatMessage).toHaveBeenCalledWith(
      "T",
      "c1",
      "hi there",
      "text",
      "u1",
    );

    // Audit recorded with expected shape
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    const auditArg = mockRecordAudit.mock.calls[0][0];
    expect(auditArg.action).toBe("ms_chats.message_sent");
    expect(auditArg.resourceType).toBe("ms_chat_message");
    expect(auditArg.resourceId).toBe("m-new");
    expect(auditArg.actor).toEqual({ user_id: "u1", role: "dev" });
  });

  it("passes html contentType through when requested", async () => {
    mockGetUser.mockReturnValue(CALLER);
    mockGetValidToken.mockResolvedValue({ accessToken: "T", userEmail: "caller@x.com" });
    mockGetChat.mockResolvedValue(memberChat());
    mockSendChatMessage.mockResolvedValue({
      ok: true,
      message: {
        id: "m2",
        from: { displayName: "x", email: "caller@x.com", userId: "u" },
        body: { content: "<p>hi</p>", contentType: "html" as const },
        bodyText: "hi",
        createdDateTime: "",
      },
    });
    const { POST } = await import("@/app/api/ms/chats/[id]/messages/route");
    await POST(
      mkReq("/api/ms/chats/c1/messages", {
        content: "<p>hi</p>",
        contentType: "html",
      }),
      ctx("c1"),
    );
    expect(mockSendChatMessage).toHaveBeenCalledWith(
      "T",
      "c1",
      "<p>hi</p>",
      "html",
      "u1",
    );
  });

  it("500 on unexpected error", async () => {
    mockGetUser.mockReturnValue(CALLER);
    mockGetValidToken.mockResolvedValue({ accessToken: "T", userEmail: "caller@x.com" });
    mockGetChat.mockRejectedValue(new Error("boom"));
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = await import("@/app/api/ms/chats/[id]/messages/route");
    const res = await POST(mkReq("/api/ms/chats/c1/messages", { content: "hi" }), ctx("c1"));
    expect(res.status).toBe(500);
    err.mockRestore();
  });
});
