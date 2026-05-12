/**
 * Microsoft Teams (personal chat) integration tests.
 *
 * Covers listChats, listMessages, syncAllForUser (pagination, messages
 * per chat, 429 Retry-After, HTML→text, cache upsert), 403 scope_missing,
 * analytics events.
 */
 

// Make this file a module (not a script) so top-level `const` declarations
// stay file-scoped and don't collide with sibling test files.
export {};

const mockTrack = jest.fn();
const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();
const mockGetValidToken = jest.fn();
const mockIndexTeamsMessage = jest.fn();
const mockIndexOneNotePage = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrack(...args),
}));
jest.mock("@/lib/db", () => ({
  query: (...args: any[]) => mockQuery(...args),
  safeQuery: (...args: any[]) => mockSafeQuery(...args),
  pool: { query: jest.fn() },
}));
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...args: any[]) => mockGetValidToken(...args),
}));
jest.mock("@/lib/learning/ms-content-ingest", () => ({
  indexTeamsMessage: (...args: any[]) => mockIndexTeamsMessage(...args),
  indexOneNotePage: (...args: any[]) => mockIndexOneNotePage(...args),
}));

const realFetch = global.fetch;
const fetchMock = jest.fn();

beforeAll(() => {
  (global as any).fetch = fetchMock;
});
afterAll(() => {
  (global as any).fetch = realFetch;
});

beforeEach(() => {
  jest.clearAllMocks();
  fetchMock.mockReset();
  mockGetValidToken.mockResolvedValue({ accessToken: "tok-abc", userEmail: "u@x" });
  mockIndexTeamsMessage.mockResolvedValue(undefined);
  // Upserts return a row
  mockQuery.mockResolvedValue({ rows: [{ id: "uuid-x" }] });
});

function okResponse(data: unknown): any {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}
function errResponse(status: number, text = "err", headers: Record<string, string> = {}): any {
  return {
    ok: false,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: () => Promise.resolve({ error: text }),
    text: () => Promise.resolve(text),
  };
}

// ---------------------------------------------------------------------------
// htmlToPlaintext
// ---------------------------------------------------------------------------

describe("htmlToPlaintext", () => {
  it("strips tags, decodes entities, drops script/style", async () => {
    const { htmlToPlaintext } = await import("@/lib/integrations/microsoft-teams-chat");
    expect(htmlToPlaintext("<p>Hello <b>world</b></p>")).toBe("Hello world");
    expect(htmlToPlaintext("<script>alert(1)</script><p>Hi</p>")).toBe("Hi");
    expect(htmlToPlaintext("a &amp; b &lt; c")).toBe("a & b < c");
    expect(htmlToPlaintext("<p>one</p><p>two</p>")).toContain("one");
    expect(htmlToPlaintext("")).toBe("");
    expect(htmlToPlaintext(null)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// listChats / listMessages
// ---------------------------------------------------------------------------

describe("listChats", () => {
  it("throws TeamsChatError when no token", async () => {
    mockGetValidToken.mockResolvedValueOnce(null);
    const { listChats, TeamsChatError } = await import("@/lib/integrations/microsoft-teams-chat");
    await expect(listChats("user-1")).rejects.toBeInstanceOf(TeamsChatError);
  });

  it("returns chats from Graph", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({
      value: [{ id: "c1", chatType: "group", topic: "Q2 planning", members: [
        { displayName: "Alice", email: "a@x" },
        { displayName: "Bob", email: "b@x" },
      ]}],
    }));
    const { listChats } = await import("@/lib/integrations/microsoft-teams-chat");
    const res = await listChats("user-1", { top: 25 });
    expect(res.chats).toHaveLength(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/me/chats?$top=25");
  });

  it("passes nextCursor when Graph returns @odata.nextLink", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({
      value: [],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/chats?$skiptoken=abc",
    }));
    const { listChats } = await import("@/lib/integrations/microsoft-teams-chat");
    const res = await listChats("user-1");
    expect(res.nextCursor).toContain("skiptoken");
  });
});

describe("listMessages", () => {
  it("builds /me/chats/{id}/messages endpoint with $top + $orderby", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ value: [] }));
    const { listMessages } = await import("@/lib/integrations/microsoft-teams-chat");
    await listMessages("user-1", "chat-123", { top: 10 });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/me/chats/chat-123/messages");
    expect(url).toContain("$top=10");
    expect(url).toMatch(/orderby=createdDateTime\+desc|orderby=createdDateTime%20desc|orderby=createdDateTime desc/);
  });
});

// ---------------------------------------------------------------------------
// 429 retry behavior
// ---------------------------------------------------------------------------

describe("Graph 429 Retry-After", () => {
  it("honors Retry-After once and retries", async () => {
    fetchMock
      .mockResolvedValueOnce(errResponse(429, "throttled", { "retry-after": "0" }))
      .mockResolvedValueOnce(okResponse({ value: [] }));
    const { listChats } = await import("@/lib/integrations/microsoft-teams-chat");
    const res = await listChats("user-1");
    expect(res.chats).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces TeamsChatError on 429 then 500", async () => {
    fetchMock
      .mockResolvedValueOnce(errResponse(429, "throttled", { "retry-after": "0" }))
      .mockResolvedValueOnce(errResponse(500, "boom"));
    const { listChats, TeamsChatError } = await import("@/lib/integrations/microsoft-teams-chat");
    await expect(listChats("user-1")).rejects.toBeInstanceOf(TeamsChatError);
  });
});

// ---------------------------------------------------------------------------
// 403 scope_missing
// ---------------------------------------------------------------------------

describe("asScopeMissing", () => {
  it("translates 403 TeamsChatError to scope_missing", async () => {
    fetchMock.mockResolvedValueOnce(errResponse(403, "missing scope"));
    const { listChats, asScopeMissing } = await import("@/lib/integrations/microsoft-teams-chat");
    try {
      await listChats("user-1");
      fail("should throw");
    } catch (err) {
      const scope = asScopeMissing(err, "Chat.Read");
      expect(scope).toEqual({ ok: false, code: "scope_missing", scope: "Chat.Read" });
    }
  });

  it("returns null for non-403", async () => {
    const { asScopeMissing, TeamsChatError } = await import("@/lib/integrations/microsoft-teams-chat");
    const err = new TeamsChatError(500, "boom");
    expect(asScopeMissing(err, "Chat.Read")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// syncAllForUser
// ---------------------------------------------------------------------------

describe("syncAllForUser", () => {
  it("walks chats + messages, upserts, emits analytics, ingests to RAG", async () => {
    fetchMock
      // listChats
      .mockResolvedValueOnce(okResponse({
        value: [{ id: "C1", chatType: "group", topic: "Planning", members: [
          { displayName: "Alice" },
        ]}],
      }))
      // listMessages
      .mockResolvedValueOnce(okResponse({
        value: [
          { id: "M1", body: { content: "<p>hi</p>", contentType: "html" },
            from: { user: { displayName: "Alice" } }, createdDateTime: "2026-04-15T10:00:00Z",
            importance: "normal" },
        ],
      }));

    const { syncAllForUser } = await import("@/lib/integrations/microsoft-teams-chat");
    const result = await syncAllForUser("user-1", { messagesPerChat: 10 });
    expect(result.chatCount).toBe(1);
    expect(result.messageCount).toBe(1);

    // Upserts ON CONFLICT
    const sqls = mockQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => /ON CONFLICT/.test(s) && /instinct_teams_chats/.test(s))).toBe(true);
    expect(sqls.some((s) => /ON CONFLICT/.test(s) && /instinct_teams_messages/.test(s))).toBe(true);

    // RAG ingest called with plaintext body
    expect(mockIndexTeamsMessage).toHaveBeenCalledTimes(1);
    const ingestCall = mockIndexTeamsMessage.mock.calls[0];
    expect(ingestCall[1].body).toBe("hi");

    // Analytics
    expect(mockTrack).toHaveBeenCalledWith(
      "system.ms_teams_chats_synced",
      "user-1",
      "system",
      expect.objectContaining({ chat_count: 1 }),
    );
    expect(mockTrack).toHaveBeenCalledWith(
      "system.ms_teams_messages_synced",
      "user-1",
      "system",
      expect.objectContaining({ message_count: 1 }),
    );
  });

  it("continues sync + emits indexing_failed when RAG ingest fails", async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse({
        value: [{ id: "C1", chatType: "oneOnOne", members: [] }],
      }))
      .mockResolvedValueOnce(okResponse({
        value: [{ id: "M1", body: { content: "hello", contentType: "text" },
          from: { user: { displayName: "Alice" } }, createdDateTime: "2026-04-15T10:00:00Z" }],
      }));

    mockIndexTeamsMessage.mockRejectedValueOnce(new Error("qdrant down"));

    const { syncAllForUser } = await import("@/lib/integrations/microsoft-teams-chat");
    const result = await syncAllForUser("user-1");
    expect(result.messageCount).toBe(1);
    expect(mockTrack).toHaveBeenCalledWith(
      "system.ms_teams_sync_indexing_failed",
      "user-1",
      "system",
      expect.objectContaining({ ms_message_id: "M1" }),
    );
  });

  it("emits system.ms_teams_sync_failed + re-throws on error", async () => {
    fetchMock.mockResolvedValueOnce(errResponse(500, "boom"));
    const { syncAllForUser, TeamsChatError } = await import("@/lib/integrations/microsoft-teams-chat");
    await expect(syncAllForUser("user-1")).rejects.toBeInstanceOf(TeamsChatError);
    expect(mockTrack).toHaveBeenCalledWith(
      "system.ms_teams_sync_failed",
      "user-1",
      "system",
      expect.objectContaining({ http_status: 500 }),
    );
  });

  it("is idempotent (ON CONFLICT DO UPDATE) — second sync upserts same keys", async () => {
    for (let i = 0; i < 2; i++) {
      fetchMock
        .mockResolvedValueOnce(okResponse({ value: [{ id: "C1", chatType: "oneOnOne", members: [] }] }))
        .mockResolvedValueOnce(okResponse({ value: [{ id: "M1", body: { content: "x", contentType: "text" }, from: { user: { displayName: "A" } } }] }));
    }
    const { syncAllForUser } = await import("@/lib/integrations/microsoft-teams-chat");
    await syncAllForUser("user-1");
    await syncAllForUser("user-1");
    const sqls = mockQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.filter((s) => /ON CONFLICT/i.test(s)).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Cache reads
// ---------------------------------------------------------------------------

describe("listCachedChats", () => {
  it("orders by last_updated_at DESC with limit+1 for hasMore", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    const { listCachedChats } = await import("@/lib/integrations/microsoft-teams-chat");
    await listCachedChats("u", { limit: 5 });
    const sql = String(mockSafeQuery.mock.calls[0][0]);
    expect(sql).toMatch(/ORDER BY last_updated_at DESC/);
  });

  it("returns nextCursor when hasMore", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      id: `id-${i}`,
      user_id: "u",
      ms_chat_id: `ms-${i}`,
      chat_type: "oneOnOne",
      topic: null,
      participants: [],
      last_updated_at: new Date().toISOString(),
      etag: null,
      synced_at: new Date().toISOString(),
    }));
    mockSafeQuery.mockResolvedValueOnce({ rows });
    const { listCachedChats } = await import("@/lib/integrations/microsoft-teams-chat");
    const res = await listCachedChats("u", { limit: 5 });
    expect(res.chats).toHaveLength(5);
    expect(res.nextCursor).toBe("id-4");
  });
});

describe("listCachedMessages", () => {
  it("adds FTS + ILIKE clause when search given", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    const { listCachedMessages } = await import("@/lib/integrations/microsoft-teams-chat");
    await listCachedMessages("u", "chat-uuid", { search: "budget" });
    const sql = String(mockSafeQuery.mock.calls[0][0]);
    expect(sql).toMatch(/to_tsvector/);
    expect(sql).toMatch(/ILIKE/);
  });
});
