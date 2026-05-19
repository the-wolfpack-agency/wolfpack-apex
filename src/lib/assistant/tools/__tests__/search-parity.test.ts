/**
 * search-parity — load-bearing test.
 *
 * Asserts that the assistant `search` tool and the /api/search HTTP
 * handler return IDENTICAL SearchResponse bodies for the same query.
 * Drift between the two surfaces was the original v1 risk: if the tool
 * ever stops delegating to the shared runSearch() (or callers start
 * branching on caller-shape inside runSearch), this test fails.
 *
 * The five retriever modules are mocked once with shared fixtures so
 * both call paths see the exact same data. `getUserFromRequest` is
 * stubbed to return the same user the tool ctx uses, so the only
 * remaining variable is the wiring itself.
 *
 * One regression case is included: the tool's matchIntent MUST return
 * null for CRM-shaped phrasings ("find the contact for Acme") so the
 * more-specific CRM tool wins the cascade.
 */

const mockGetUser = jest.fn();
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

jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: unknown[]) => mockGetUser(...a),
}));
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
  /* search_external_records reaches in via the connectors barrel for
     getConnector — provide a no-op so the import doesn't blow up.
     The route path doesn't dispatch the CRM tool; this is purely
     module-load defensiveness. */
  getConnector: jest.fn().mockReturnValue(null),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/search/route";
import { searchTool } from "@/lib/assistant/tools/search";

const USER_ID = "user-parity";
const USER_ROLE = "ceo";

function makeReq(query: string): NextRequest {
  const qs = query ? `?q=${encodeURIComponent(query)}` : "?q=";
  return new NextRequest(`https://x.test/api/search${qs}`, {
    method: "GET",
    headers: { authorization: "Bearer parity-token" },
  });
}

/* Shared fixtures — both surfaces read these. Updates here flow to
   both the route response and the tool response, so any divergence is
   wiring drift, not data drift. */
function applyHappyFixtures(query: string) {
  mockListChatsResult.mockResolvedValue({
    ok: true,
    chats: [
      {
        id: "chat-p1",
        topic: `${query} working group`,
        chatType: "group",
        lastUpdatedDateTime: "2026-04-22T10:00:00Z",
        members: [{ displayName: "James", email: "j@x.co", userId: "j" }],
        lastMessagePreview: {
          body: { content: `${query} status update`, contentType: "text" },
          bodyText: `${query} status update`,
          from: { displayName: "James", email: "j@x.co", userId: "j" },
          createdDateTime: "2026-04-22T10:00:00Z",
        },
      },
    ],
  });
  mockFetchRecentEmails.mockResolvedValue([
    {
      id: "mail-p1",
      subject: `RE: ${query} quarterly`,
      from: "James",
      fromEmail: "j@x.co",
      receivedDateTime: "2026-04-22T08:00:00Z",
      bodyPreview: `Legal approved the ${query} SOW`,
      isRead: false,
      importance: "normal",
    },
  ]);
  mockFetchCalendarEvents.mockResolvedValue([
    {
      id: "evt-p1",
      subject: `${query} strategy`,
      start: "2026-04-22T14:00:00Z",
      end: "2026-04-22T15:00:00Z",
      location: "Teams",
      attendees: ["James"],
      attendeeEmails: ["j@x.co"],
      isOnlineMeeting: true,
      webLink: "https://outlook.test/evt-p1",
      joinUrl: null,
    },
  ]);
  mockListJoinedTeams.mockResolvedValue({
    ok: true,
    teams: [{ id: "team-p1", displayName: `${query} Team` }],
  });
  mockListTeamChannels.mockResolvedValue({
    ok: true,
    channels: [
      {
        id: "chan-p1",
        displayName: "general",
        description: `${query} channel`,
        webUrl: "https://teams.test/chan-p1",
      },
    ],
  });
  mockSearchKnowledge.mockResolvedValue([
    {
      id: "kb-p1",
      question: `What is ${query}?`,
      answer: `Answer about ${query}.`,
      source: "manual",
      asked_by: USER_ID,
      confidence: 0.9,
      rating: null,
      view_count: 1,
      tokens_used: 0,
      tags: [],
      created_at: "2026-04-20T00:00:00Z",
      updated_at: "2026-04-22T00:00:00Z",
    },
  ]);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockReturnValue({
    id: USER_ID,
    role: USER_ROLE,
    name: "Parity",
    email: "parity@x.co",
    workspaceId: "ws-parity",
  });
  mockGetValidToken.mockResolvedValue({
    accessToken: "ms-tok",
    userEmail: "parity@x.co",
  });
  mockFetchRecentEmails.mockResolvedValue([]);
  mockFetchCalendarEvents.mockResolvedValue([]);
  mockListChatsResult.mockResolvedValue({ ok: true, chats: [] });
  mockGetChatMessagesResult.mockResolvedValue({ ok: true, messages: [] });
  mockListJoinedTeams.mockResolvedValue({ ok: true, teams: [] });
  mockListTeamChannels.mockResolvedValue({ ok: true, channels: [] });
  mockListChannelMessages.mockResolvedValue({ ok: true, messages: [] });
  mockSearchKnowledge.mockResolvedValue([]);
  /* CRM provider: workspace has Salesforce active, single matching
     record so the parity assertion sees the same CRM hit through
     both surfaces. */
  mockPickConfigured.mockResolvedValue("salesforce");
  mockBuildRest.mockResolvedValue({
    name: "salesforce",
    description: "test",
    isConfigured: () => true,
    getRecord: jest.fn().mockResolvedValue({ ok: true, data: {} }),
    searchRecords: jest.fn().mockResolvedValue({
      ok: true,
      data: [{ Id: "001xyz", Name: "Parity Record" }],
    }),
  });
  mockLoadCredentials.mockResolvedValue({
    workspaceId: "ws-parity",
    connectorName: "salesforce",
    baseUrl: "https://acme.my.salesforce.com",
    authHeader: "Bearer ...",
    isActive: true,
    authType: "oauth2",
    accessTokenExpiresAt: null,
  });
});

/* `took_ms` is wall-clock latency — non-deterministic across two
   sequential invocations. Strip it before deep-equality so the parity
   assertion isn't flaky, but assert it's present and numeric on both
   sides so we still catch a missing field. */
function stripTookMs<T extends { took_ms: number }>(body: T): Omit<T, "took_ms"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { took_ms, ...rest } = body;
  return rest;
}

describe("search tool ↔ /api/search route — parity", () => {
  test.each([
    ["porsche"],
    ["acme deals"],
    ["x"],
  ])("returns identical SearchResponse for query=%j", async (query) => {
    applyHappyFixtures(query);

    /* Route path. */
    const res = await GET(makeReq(query));
    expect(res.status).toBe(200);
    const routeBody = await res.json();

    /* Tool path — call the handler directly with matching ctx. */
    const toolRes = await searchTool.handler(
      { query },
      { userId: USER_ID, userRole: USER_ROLE, workspaceId: "ws-parity" },
    );

    expect(toolRes.ok).toBe(true);
    if (!toolRes.ok) return;

    /* Both surfaces saw the same fixture data, so the merged result
       lists, the per-type counts, and the result shape MUST match. */
    expect(typeof routeBody.took_ms).toBe("number");
    expect(typeof toolRes.data.took_ms).toBe("number");
    expect(stripTookMs(toolRes.data)).toEqual(stripTookMs(routeBody));
  });

  test("empty-query route load returns a well-formed shape (tool rejects this input at zod)", async () => {
    /* The /search page initial load fires q=""; the route returns the
       page-load shape. The tool's zod schema enforces min(1) — bare
       Universal Search isn't a meaningful chat intent — so this case
       is route-only. We still pin the shape so the route's empty-query
       contract is locked in. */
    const res = await GET(makeReq(""));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.counts).toEqual(
      expect.objectContaining({
        chats: expect.any(Number),
        channels: expect.any(Number),
        emails: expect.any(Number),
        calendar: expect.any(Number),
        knowledge: expect.any(Number),
      }),
    );
  });

  test("CRM-shaped intent ('find the contact for Acme') is NOT claimed by search tool", () => {
    /* The whole point of registration-order + the defensive
       crmToolClaims() check inside search.matchIntent is that CRM
       phrasings never reach runSearch. If this returns non-null, the
       cascade is broken and search will shadow the more-specific
       search_external_records tool. */
    expect(searchTool.matchIntent("find the contact for Acme")).toBeNull();
  });

  test("capability is the assistant-wide unrestricted value", () => {
    /* Tool registration spec — anyone authenticated may search their
       own surfaces. Locks this in so a future tightening (e.g. dropping
       knowledge from anon users) is an explicit change, not silent. */
    expect(searchTool.capability).toBe("*");
  });
});
