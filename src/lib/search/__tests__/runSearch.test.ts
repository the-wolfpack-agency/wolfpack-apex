/**
 * runSearch — unit tests.
 *
 * Locks in:
 *   - Happy path: every provider returns data, response shape correct,
 *     results interleaved across types (including CRM).
 *   - Empty query: returns empty results (no chats match "" with
 *     mocked-empty Graph), counts zero, fast.
 *   - One provider throws: degrades gracefully — other providers still
 *     return AND the engine emits `system.search_provider_failed`.
 *   - Limit cap: limit=200 clamped to MAX_LIMIT (50).
 *   - types filter: types=["email"] only invokes the email provider.
 *   - CRM provider: when enabled, fans into the workspace's configured
 *     connector via the same code path search_external_records uses.
 *
 * Every backing module (Graph helpers, knowledge index, connector
 * framework, analytics shim) is mocked so the test runs offline +
 * deterministic.
 */

const mockGetValidToken = jest.fn();
const mockFetchRecentEmails = jest.fn();
const mockFetchCalendarEvents = jest.fn();
const mockListChatsResult = jest.fn();
const mockGetChatMessagesResult = jest.fn();
const mockListJoinedTeams = jest.fn();
const mockListTeamChannels = jest.fn();
const mockListChannelMessages = jest.fn();
const mockSearchKnowledge = jest.fn();
const mockBuildRest = jest.fn();
const mockPickConfigured = jest.fn();
const mockLoadCredentials = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...a: unknown[]) => mockGetValidToken(...a),
  fetchRecentEmails: (...a: unknown[]) => mockFetchRecentEmails(...a),
  fetchCalendarEvents: (...a: unknown[]) => mockFetchCalendarEvents(...a),
}));
jest.mock("@/lib/ms-graph-chats", () => ({
  listChatsResult: (...a: unknown[]) => mockListChatsResult(...a),
  getChatMessagesResult: (...a: unknown[]) => mockGetChatMessagesResult(...a),
}));
jest.mock("@/lib/ms-graph-teams", () => ({
  listJoinedTeams: (...a: unknown[]) => mockListJoinedTeams(...a),
  listTeamChannels: (...a: unknown[]) => mockListTeamChannels(...a),
  listChannelMessages: (...a: unknown[]) => mockListChannelMessages(...a),
}));
jest.mock("@/lib/knowledge", () => ({
  searchKnowledge: (...a: unknown[]) => mockSearchKnowledge(...a),
}));
jest.mock("@/lib/assistant/connectors", () => ({
  buildRestConnectorForWorkspace: (...a: unknown[]) => mockBuildRest(...a),
  pickConfiguredConnector: (...a: unknown[]) => mockPickConfigured(...a),
  loadConnectorCredentials: (...a: unknown[]) => mockLoadCredentials(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import { runSearch, MAX_LIMIT } from "@/lib/search/runSearch";

/** Returns a connector mock matching the framework's Connector interface
 *  enough for the CRM provider to consume — only the surface area the
 *  provider touches is implemented. */
function connectorStub(opts: {
  configured?: boolean;
  records?: Array<Record<string, unknown>>;
}) {
  return {
    name: "salesforce",
    description: "test",
    isConfigured: () => opts.configured !== false,
    getRecord: jest.fn().mockResolvedValue({ ok: true, data: {} }),
    searchRecords: jest.fn().mockResolvedValue({
      ok: true,
      data: opts.records ?? [],
    }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetValidToken.mockResolvedValue({
    accessToken: "ms-tok",
    userEmail: "u@x.co",
  });
  mockFetchRecentEmails.mockResolvedValue([]);
  mockFetchCalendarEvents.mockResolvedValue([]);
  mockListChatsResult.mockResolvedValue({ ok: true, chats: [] });
  mockGetChatMessagesResult.mockResolvedValue({ ok: true, messages: [] });
  mockListJoinedTeams.mockResolvedValue({ ok: true, teams: [] });
  mockListTeamChannels.mockResolvedValue({ ok: true, channels: [] });
  mockListChannelMessages.mockResolvedValue({ ok: true, messages: [] });
  mockSearchKnowledge.mockResolvedValue([]);
  /* Default: no CRM connector configured. CRM provider isEnabled
     returns false → not invoked. Individual tests override. */
  mockPickConfigured.mockResolvedValue(null);
  mockBuildRest.mockResolvedValue(connectorStub({ configured: false }));
  mockLoadCredentials.mockResolvedValue(null);
});

describe("runSearch", () => {
  test("happy path: returns interleaved results across all surfaces (including CRM)", async () => {
    mockListChatsResult.mockResolvedValue({
      ok: true,
      chats: [
        {
          id: "chat-1",
          topic: "Greenfield review",
          chatType: "group",
          lastUpdatedDateTime: "2026-04-22T10:00:00Z",
          members: [{ displayName: "James", email: "j@x.co", userId: "j" }],
          lastMessagePreview: {
            body: { content: "Greenfield is signing today", contentType: "text" },
            bodyText: "Greenfield is signing today",
            from: { displayName: "James", email: "j@x.co", userId: "j" },
            createdDateTime: "2026-04-22T10:00:00Z",
          },
        },
      ],
    });
    mockFetchRecentEmails.mockResolvedValue([
      {
        id: "mail-1",
        subject: "RE: Greenfield Q2",
        from: "James",
        fromEmail: "j@greenfield.co",
        receivedDateTime: "2026-04-22T08:00:00Z",
        bodyPreview: "Legal approved",
        isRead: false,
        importance: "high",
      },
    ]);
    mockFetchCalendarEvents.mockResolvedValue([
      {
        id: "evt-1",
        subject: "Greenfield strategy",
        start: "2026-04-22T14:00:00Z",
        end: "2026-04-22T15:00:00Z",
        location: "Teams",
        attendees: ["James"],
        attendeeEmails: ["j@greenfield.co"],
        isOnlineMeeting: true,
        webLink: "https://outlook.test/evt-1",
        joinUrl: null,
      },
    ]);
    mockListJoinedTeams.mockResolvedValue({
      ok: true,
      teams: [{ id: "team-1", displayName: "Greenfield" }],
    });
    mockListTeamChannels.mockResolvedValue({
      ok: true,
      channels: [
        {
          id: "chan-1",
          displayName: "general",
          description: "Greenfield team-wide",
          webUrl: "https://teams.test/chan-1",
        },
      ],
    });
    mockSearchKnowledge.mockResolvedValue([
      {
        id: "kb-1",
        question: "How to greenfield-onboard?",
        answer: "Use the wizard at /setup.",
        source: "manual",
        asked_by: "u1",
        confidence: 0.9,
        rating: null,
        view_count: 5,
        tokens_used: 0,
        tags: [],
        created_at: "2026-04-20T00:00:00Z",
        updated_at: "2026-04-22T00:00:00Z",
      },
    ]);
    /* CRM provider: workspace has a Salesforce connector with one
       matching Contact across the 3 object types the provider walks. */
    mockPickConfigured.mockResolvedValue("salesforce");
    mockBuildRest.mockResolvedValue(
      connectorStub({
        configured: true,
        records: [{ Id: "003abc", Name: "Greenfield Industries" }],
      }),
    );
    mockLoadCredentials.mockResolvedValue({
      workspaceId: "ws1",
      connectorName: "salesforce",
      baseUrl: "https://acme.my.salesforce.com",
      authHeader: "Bearer ...",
      isActive: true,
      authType: "oauth2",
      accessTokenExpiresAt: null,
    });

    const body = await runSearch(
      { query: "greenfield" },
      { userId: "u1", workspaceId: "ws1" },
    );

    expect(body.counts).toEqual(
      expect.objectContaining({
        chats: 1,
        channels: 1,
        emails: 1,
        calendar: 1,
        knowledge: 1,
      }),
    );
    /* CRM provider walks 3 object types; same record returned for
       each so the merged count is 3. */
    expect(body.counts.crm).toBeGreaterThanOrEqual(1);
    const types = body.results.map((r) => r.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "chat",
        "email",
        "calendar",
        "channel",
        "knowledge",
        "crm",
      ]),
    );
    expect(typeof body.took_ms).toBe("number");
  });

  test("empty query: returns the page-load shape (every provider 0)", async () => {
    mockSearchKnowledge.mockResolvedValue([]);
    const body = await runSearch({ query: "" }, { userId: "u1" });
    expect(body.results).toEqual([]);
    expect(body.counts).toEqual(
      expect.objectContaining({
        chats: 0,
        channels: 0,
        emails: 0,
        calendar: 0,
        knowledge: 0,
        crm: 0,
      }),
    );
  });

  test("one provider throws: other surfaces still return AND failure event fires", async () => {
    mockFetchRecentEmails.mockRejectedValue(new Error("graph 503"));
    mockSearchKnowledge.mockResolvedValue([
      {
        id: "kb-1",
        question: "onboarding",
        answer: "wizard",
        source: "manual",
        asked_by: "u1",
        confidence: 0.9,
        rating: null,
        view_count: 5,
        tokens_used: 0,
        tags: [],
        created_at: "2026-04-20T00:00:00Z",
        updated_at: "2026-04-22T00:00:00Z",
      },
    ]);

    const body = await runSearch(
      { query: "onboarding" },
      { userId: "u1" },
    );

    /* Email provider rejected → counts.emails = 0, but knowledge still
       returns its hit. runSearch never throws. */
    expect(body.counts.emails).toBe(0);
    expect(body.counts.knowledge).toBe(1);
    expect(body.results.some((r) => r.type === "knowledge")).toBe(true);

    /* Failure event fired with provider name + error message; no PII
       leaked. */
    const failed = mockTrackEvent.mock.calls.find(
      ([name]) => name === "system.search_provider_failed",
    );
    expect(failed).toBeDefined();
    if (!failed) return;
    const [, , , payload] = failed;
    expect(payload).toEqual(
      expect.objectContaining({
        provider: expect.any(String),
        message: expect.stringContaining("graph 503"),
      }),
    );
  });

  test("limit cap: limit=200 is clamped to MAX_LIMIT (50)", async () => {
    const big = Array.from({ length: 200 }, (_, i) => ({
      id: `kb-${i}`,
      question: `q${i}`,
      answer: `a${i}`,
      source: "manual",
      asked_by: "u1",
      confidence: 0.9,
      rating: null,
      view_count: 0,
      tokens_used: 0,
      tags: [],
      created_at: "2026-04-20T00:00:00Z",
      updated_at: "2026-04-22T00:00:00Z",
    }));
    mockSearchKnowledge.mockResolvedValue(big);

    const body = await runSearch(
      { query: "q", limit: 200, types: ["knowledge"] },
      { userId: "u1" },
    );
    expect(body.results.length).toBeLessThanOrEqual(MAX_LIMIT);
  });

  test("types filter: types=['email'] only invokes the email provider", async () => {
    await runSearch(
      { query: "anything", types: ["email"] },
      { userId: "u1" },
    );
    expect(mockFetchRecentEmails).toHaveBeenCalledTimes(1);
    expect(mockListChatsResult).not.toHaveBeenCalled();
    expect(mockFetchCalendarEvents).not.toHaveBeenCalled();
    expect(mockListJoinedTeams).not.toHaveBeenCalled();
    expect(mockSearchKnowledge).not.toHaveBeenCalled();
    /* CRM provider must also be skipped — its isEnabled would call
       pickConfiguredConnector if it ran. */
    expect(mockPickConfigured).not.toHaveBeenCalled();
  });

  test("CRM provider: passes the same query/workspaceId into the connector framework search_external_records uses", async () => {
    mockPickConfigured.mockResolvedValue("salesforce");
    const conn = connectorStub({
      configured: true,
      records: [{ Id: "001xyz", Name: "Acme Inc" }],
    });
    mockBuildRest.mockResolvedValue(conn);

    const body = await runSearch(
      { query: "Acme", types: ["crm"] },
      { userId: "u1", workspaceId: "ws1" },
    );

    expect(mockPickConfigured).toHaveBeenCalledWith("ws1");
    expect(mockBuildRest).toHaveBeenCalledWith("ws1", "salesforce");
    /* Provider walks contact / deal / account — each fires
       searchRecords against the same connector instance. */
    expect(conn.searchRecords).toHaveBeenCalled();
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results.every((r) => r.type === "crm")).toBe(true);
  });

  test("CRM provider: not enabled when no connector is configured AND no env default → skipped", async () => {
    mockPickConfigured.mockResolvedValue(null);
    mockBuildRest.mockResolvedValue(connectorStub({ configured: false }));

    const body = await runSearch(
      { query: "Acme", types: ["crm"] },
      { userId: "u1", workspaceId: "ws1" },
    );

    expect(body.results).toEqual([]);
    expect(body.counts.crm).toBe(0);
  });
});
