/**
 * Microsoft Teams CHANNEL messages integration tests.
 *
 * Covers listMyTeams, listChannels, listChannelMessages, listReplies,
 * syncAllChannels (pagination, 429 Retry-After, HTML→text, RAG index,
 * indexing failure path), 403 scope_missing, analytics events.
 */
 

// Isolate top-level const declarations from sibling test files.
export {};

const mockTrackCM = jest.fn();
const mockQueryCM = jest.fn();
const mockSafeQueryCM = jest.fn();
const mockGetValidTokenCM = jest.fn();
const mockSaveAnswerCM = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrackCM(...args),
}));
jest.mock("@/lib/db", () => ({
  query: (...args: any[]) => mockQueryCM(...args),
  safeQuery: (...args: any[]) => mockSafeQueryCM(...args),
  pool: { query: jest.fn() },
}));
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...args: any[]) => mockGetValidTokenCM(...args),
}));
jest.mock("@/lib/knowledge", () => ({
  saveAnswer: (...args: any[]) => mockSaveAnswerCM(...args),
}));

const realFetchCM = global.fetch;
const fetchMockCM = jest.fn();

beforeAll(() => {
  (global as any).fetch = fetchMockCM;
});
afterAll(() => {
  (global as any).fetch = realFetchCM;
});

beforeEach(() => {
  jest.clearAllMocks();
  fetchMockCM.mockReset();
  mockGetValidTokenCM.mockResolvedValue({
    accessToken: "tok-abc",
    userEmail: "u@x",
  });
  mockSaveAnswerCM.mockResolvedValue({ id: "ans-1" });
  mockQueryCM.mockResolvedValue({ rows: [{ id: "uuid-x" }] });
});

function okResp(data: unknown, headers: Record<string, string> = {}): any {
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}
function errResp(
  status: number,
  text = "err",
  headers: Record<string, string> = {},
): any {
  return {
    ok: false,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: () => Promise.resolve({ error: text }),
    text: () => Promise.resolve(text),
  };
}

// ---------------------------------------------------------------------------
// listMyTeams / listChannels / listChannelMessages / listReplies
// ---------------------------------------------------------------------------

describe("listMyTeams", () => {
  it("throws ChannelMessagesError when no token", async () => {
    mockGetValidTokenCM.mockResolvedValueOnce(null);
    const mod = await import("@/lib/integrations/microsoft-channel-messages");
    await expect(mod.listMyTeams("u-1")).rejects.toBeInstanceOf(
      mod.ChannelMessagesError,
    );
  });

  it("returns teams array from /me/joinedTeams", async () => {
    fetchMockCM.mockResolvedValueOnce(
      okResp({ value: [{ id: "t1", displayName: "Eng" }] }),
    );
    const mod = await import("@/lib/integrations/microsoft-channel-messages");
    const teams = await mod.listMyTeams("u-1");
    expect(teams).toHaveLength(1);
    expect(fetchMockCM.mock.calls[0][0]).toContain("/me/joinedTeams");
  });
});

describe("listChannels", () => {
  it("hits /teams/{id}/channels", async () => {
    fetchMockCM.mockResolvedValueOnce(okResp({ value: [{ id: "ch1" }] }));
    const mod = await import("@/lib/integrations/microsoft-channel-messages");
    await mod.listChannels("u-1", "t-1");
    expect(fetchMockCM.mock.calls[0][0]).toContain("/teams/t-1/channels");
  });
});

describe("listChannelMessages pagination", () => {
  it("caps $top at 50", async () => {
    fetchMockCM.mockResolvedValueOnce(okResp({ value: [] }));
    const mod = await import("@/lib/integrations/microsoft-channel-messages");
    await mod.listChannelMessages("u-1", "t-1", "c-1", { top: 999 });
    expect(fetchMockCM.mock.calls[0][0]).toContain("$top=50");
  });

  it("forwards @odata.nextLink as nextCursor and follows cursor in next call", async () => {
    fetchMockCM.mockResolvedValueOnce(
      okResp({
        value: [],
        "@odata.nextLink":
          "https://graph.microsoft.com/v1.0/teams/t-1/channels/c-1/messages?$skiptoken=abc",
      }),
    );
    const mod = await import("@/lib/integrations/microsoft-channel-messages");
    const { nextCursor } = await mod.listChannelMessages("u-1", "t-1", "c-1");
    expect(nextCursor).toContain("skiptoken");

    fetchMockCM.mockResolvedValueOnce(okResp({ value: [] }));
    await mod.listChannelMessages("u-1", "t-1", "c-1", { cursor: nextCursor });
    expect(fetchMockCM.mock.calls[1][0]).toContain("skiptoken");
  });
});

describe("listReplies", () => {
  it("builds /teams/{id}/channels/{id}/messages/{id}/replies", async () => {
    fetchMockCM.mockResolvedValueOnce(okResp({ value: [] }));
    const mod = await import("@/lib/integrations/microsoft-channel-messages");
    await mod.listReplies("u-1", "t-1", "c-1", "m-1");
    expect(fetchMockCM.mock.calls[0][0]).toContain(
      "/teams/t-1/channels/c-1/messages/m-1/replies",
    );
  });
});

// ---------------------------------------------------------------------------
// 429 retry + 403 scope_missing
// ---------------------------------------------------------------------------

describe("Graph 429 Retry-After", () => {
  it("honors Retry-After once and retries", async () => {
    fetchMockCM
      .mockResolvedValueOnce(errResp(429, "throttled", { "retry-after": "0" }))
      .mockResolvedValueOnce(okResp({ value: [] }));
    const mod = await import("@/lib/integrations/microsoft-channel-messages");
    const teams = await mod.listMyTeams("u-1");
    expect(teams).toEqual([]);
    expect(fetchMockCM).toHaveBeenCalledTimes(2);
  });

  it("throws when retry also fails with retryAfter seconds", async () => {
    fetchMockCM
      .mockResolvedValueOnce(errResp(429, "throttled", { "retry-after": "0" }))
      .mockResolvedValueOnce(errResp(500, "bad"));
    const mod = await import("@/lib/integrations/microsoft-channel-messages");
    await expect(mod.listMyTeams("u-1")).rejects.toMatchObject({
      status: 500,
      name: "ChannelMessagesError",
    });
  });
});

describe("403 scope_missing", () => {
  it("asScopeMissing converts 403 ChannelMessagesError", async () => {
    fetchMockCM.mockResolvedValueOnce(errResp(403, "forbidden"));
    const mod = await import("@/lib/integrations/microsoft-channel-messages");
    try {
      await mod.listMyTeams("u-1");
      fail("expected throw");
    } catch (err) {
      const conv = mod.asScopeMissing(err, "ChannelMessage.Read.All");
      expect(conv).toEqual({
        ok: false,
        code: "scope_missing",
        scope: "ChannelMessage.Read.All",
      });
    }
  });

  it("asScopeMissing returns null for non-403", async () => {
    const mod = await import("@/lib/integrations/microsoft-channel-messages");
    expect(
      mod.asScopeMissing(new Error("bare"), "ChannelMessage.Read.All"),
    ).toBeNull();
    const err500 = new mod.ChannelMessagesError(500, "server");
    expect(mod.asScopeMissing(err500, "ChannelMessage.Read.All")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// syncAllChannels: end-to-end walk with analytics
// ---------------------------------------------------------------------------

describe("syncAllChannels", () => {
  it("walks teams → channels → messages and emits synced events", async () => {
    // /me/joinedTeams
    fetchMockCM.mockResolvedValueOnce(
      okResp({ value: [{ id: "t1", displayName: "Eng" }] }),
    );
    // /teams/t1/channels
    fetchMockCM.mockResolvedValueOnce(
      okResp({ value: [{ id: "c1", displayName: "general" }] }),
    );
    // /teams/t1/channels/c1/messages
    fetchMockCM.mockResolvedValueOnce(
      okResp({
        value: [
          {
            id: "m1",
            replyToId: null,
            createdDateTime: "2026-04-01T00:00:00Z",
            body: { content: "<p>hello <b>world</b></p>", contentType: "html" },
            from: { user: { id: "u-10", displayName: "Alice" } },
            subject: "Kickoff",
          },
        ],
      }),
    );
    // /teams/t1/channels/c1/messages/m1/replies
    fetchMockCM.mockResolvedValueOnce(okResp({ value: [] }));

    const mod = await import("@/lib/integrations/microsoft-channel-messages");
    const res = await mod.syncAllChannels("u-1");
    expect(res.teamCount).toBe(1);
    expect(res.channelCount).toBe(1);
    expect(res.messageCount).toBe(1);

    // Analytics events
    const names = mockTrackCM.mock.calls.map((c) => c[0]);
    expect(names).toContain("system.ms_teams_channels_synced");
    expect(names).toContain("system.ms_teams_channel_messages_synced");

    // HTML body converted to plaintext in upsert
    const upsertCall = mockQueryCM.mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO instinct_teams_channel_messages"),
    );
    expect(upsertCall).toBeTruthy();
    const params = upsertCall![1] as unknown[];
    expect(String(params[5])).toContain("hello");
    expect(String(params[5])).toContain("world");
    expect(String(params[5])).not.toContain("<b>");

    // RAG index was called
    expect(mockSaveAnswerCM).toHaveBeenCalled();
    const saveArgs = mockSaveAnswerCM.mock.calls[0];
    expect(saveArgs[2]).toBe("teams_channel_message");
  });

  it("continues when RAG indexing throws (and emits indexing_failed event)", async () => {
    mockSaveAnswerCM.mockResolvedValueOnce(null);

    fetchMockCM
      .mockResolvedValueOnce(okResp({ value: [{ id: "t1", displayName: "Eng" }] }))
      .mockResolvedValueOnce(okResp({ value: [{ id: "c1", displayName: "g" }] }))
      .mockResolvedValueOnce(
        okResp({
          value: [
            {
              id: "m1",
              replyToId: null,
              body: { content: "hello", contentType: "text" },
              from: { user: { id: "u-10", displayName: "Alice" } },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(okResp({ value: [] }));

    const mod = await import("@/lib/integrations/microsoft-channel-messages");
    const res = await mod.syncAllChannels("u-1");
    expect(res.messageCount).toBe(1);

    const names = mockTrackCM.mock.calls.map((c) => c[0]);
    expect(names).toContain("system.ms_teams_channel_sync_indexing_failed");
    expect(names).toContain("system.ms_teams_channels_synced");
  });

  it("tolerates 404 on replies (some messages don't expose replies)", async () => {
    fetchMockCM
      .mockResolvedValueOnce(okResp({ value: [{ id: "t1", displayName: "Eng" }] }))
      .mockResolvedValueOnce(okResp({ value: [{ id: "c1", displayName: "g" }] }))
      .mockResolvedValueOnce(
        okResp({
          value: [
            {
              id: "m1",
              replyToId: null,
              body: { content: "ok", contentType: "text" },
              from: { user: { id: "u-10", displayName: "Alice" } },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(errResp(404, "not found"));

    const mod = await import("@/lib/integrations/microsoft-channel-messages");
    const res = await mod.syncAllChannels("u-1");
    expect(res.messageCount).toBe(1);
  });

  it("emits channel_sync_failed on hard error and rethrows", async () => {
    fetchMockCM.mockResolvedValueOnce(errResp(500, "server"));
    const mod = await import("@/lib/integrations/microsoft-channel-messages");
    await expect(mod.syncAllChannels("u-1")).rejects.toThrow();
    const names = mockTrackCM.mock.calls.map((c) => c[0]);
    expect(names).toContain("system.ms_teams_channel_sync_failed");
  });
});

// ---------------------------------------------------------------------------
// Cache read helpers
// ---------------------------------------------------------------------------

describe("listCachedTeams / listCachedChannelMessages", () => {
  it("listCachedChannelMessages applies FTS search clause", async () => {
    mockSafeQueryCM.mockResolvedValueOnce({ rows: [] });
    const mod = await import("@/lib/integrations/microsoft-channel-messages");
    await mod.listCachedChannelMessages("u-1", "ch-local", {
      search: "budget",
      limit: 10,
    });
    const sql = String(mockSafeQueryCM.mock.calls[0][0]);
    expect(sql).toContain("plainto_tsquery");
    expect(sql).toContain("ILIKE");
  });

  it("listCachedChannelMessages paginates with nextCursor when overflow", async () => {
    // limit=2 → ask for 3 rows, return 3
    mockSafeQueryCM.mockResolvedValueOnce({
      rows: [
        {
          id: "1",
          channel_id: "ch",
          ms_message_id: "m1",
          ms_reply_to_id: null,
          sender: { id: "x" },
          subject: "s",
          body: "b",
          body_html: null,
          importance: "normal",
          created_at: new Date().toISOString(),
          updated_at: null,
          mentions: [],
          synced_at: new Date().toISOString(),
          payload: {},
        },
        {
          id: "2",
          channel_id: "ch",
          ms_message_id: "m2",
          ms_reply_to_id: null,
          sender: { id: "x" },
          subject: null,
          body: "b",
          body_html: null,
          importance: "normal",
          created_at: new Date().toISOString(),
          updated_at: null,
          mentions: [],
          synced_at: new Date().toISOString(),
          payload: {},
        },
        {
          id: "3",
          channel_id: "ch",
          ms_message_id: "m3",
          ms_reply_to_id: null,
          sender: { id: "x" },
          subject: null,
          body: "b",
          body_html: null,
          importance: "normal",
          created_at: new Date().toISOString(),
          updated_at: null,
          mentions: [],
          synced_at: new Date().toISOString(),
          payload: {},
        },
      ],
    });
    const mod = await import("@/lib/integrations/microsoft-channel-messages");
    const { messages, nextCursor } = await mod.listCachedChannelMessages(
      "u-1",
      "ch-local",
      { limit: 2 },
    );
    expect(messages).toHaveLength(2);
    expect(nextCursor).toBe("2");
  });
});
