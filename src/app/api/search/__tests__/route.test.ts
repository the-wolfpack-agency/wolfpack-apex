/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * /api/search — Universal Search v1 contract.
 *
 * Locks in:
 *   - 401 with no auth header.
 *   - Happy path returns mixed results across chats/emails/calendar.
 *   - emitInsight fires `insight.search.queried` on every request.
 *   - emitInsight fires `insight.search.no_results` when nothing matches.
 *   - `types=` filter narrows the surfaces searched.
 *
 * Mocks the Graph helpers so the test runs offline + deterministic.
 */

const mockGetUser = jest.fn();
const mockGetValidToken = jest.fn();
const mockFetchRecentEmails = jest.fn();
const mockFetchCalendarEvents = jest.fn();
const mockListChatsResult = jest.fn();
const mockGetChatMessagesResult = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: any[]) => mockGetUser(...a),
}));
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...a: any[]) => mockGetValidToken(...a),
  fetchRecentEmails: (...a: any[]) => mockFetchRecentEmails(...a),
  fetchCalendarEvents: (...a: any[]) => mockFetchCalendarEvents(...a),
}));
jest.mock("@/lib/ms-graph-chats", () => ({
  listChatsResult: (...a: any[]) => mockListChatsResult(...a),
  getChatMessagesResult: (...a: any[]) => mockGetChatMessagesResult(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));

import { NextRequest } from "next/server";
import { GET } from "../route";

function makeReq(qs: string, withAuth: boolean = true): NextRequest {
  const headers: Record<string, string> = {};
  if (withAuth) headers.authorization = "Bearer test-token";
  return new NextRequest(`https://x.test/api/search${qs}`, { method: "GET", headers });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockReturnValue({ id: "u1", role: "ceo", name: "N", email: "n@x.co" });
  mockGetValidToken.mockResolvedValue({ accessToken: "ms-tok", userEmail: "n@x.co" });
  mockFetchRecentEmails.mockResolvedValue([]);
  mockFetchCalendarEvents.mockResolvedValue([]);
  mockListChatsResult.mockResolvedValue({ ok: true, chats: [] });
  mockGetChatMessagesResult.mockResolvedValue({ ok: true, messages: [] });
});

describe("GET /api/search", () => {
  it("returns 401 when there is no auth header", async () => {
    mockGetUser.mockReturnValueOnce(null);
    const res = await GET(makeReq("?q=hello", false));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });

  it("returns mixed results across chats, emails, and calendar (happy path)", async () => {
    mockListChatsResult.mockResolvedValue({
      ok: true,
      chats: [
        {
          id: "chat-1",
          topic: "Greenfield retainer review",
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
        subject: "RE: Greenfield Q2 Retainer",
        from: "James Greenfield",
        fromEmail: "james@greenfieldcorp.com",
        receivedDateTime: "2026-04-22T08:42:00Z",
        bodyPreview: "Legal approved the SOW; ready to sign",
        isRead: false,
        importance: "high",
      },
      {
        id: "mail-2",
        subject: "Unrelated newsletter",
        from: "AWS",
        fromEmail: "aws@aws.com",
        receivedDateTime: "2026-04-21T08:00:00Z",
        bodyPreview: "Your bill is ready",
        isRead: true,
        importance: "low",
      },
    ]);
    mockFetchCalendarEvents.mockResolvedValue([
      {
        id: "evt-1",
        subject: "Greenfield strategy review",
        start: "2026-04-22T14:00:00Z",
        end: "2026-04-22T15:00:00Z",
        location: "Teams",
        attendees: ["James Greenfield"],
        attendeeEmails: ["james@greenfieldcorp.com"],
        isOnlineMeeting: true,
        webLink: "https://outlook.office.com/calendar/item/evt-1",
        joinUrl: null,
      },
    ]);

    const res = await GET(makeReq("?q=greenfield"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.counts).toEqual(
      expect.objectContaining({ chats: 1, emails: 1, calendar: 1, channels: 0, knowledge: 0 }),
    );
    const types = body.results.map((r: any) => r.type);
    expect(types).toEqual(expect.arrayContaining(["chat", "email", "calendar"]));
    expect(body.results.find((r: any) => r.type === "email").id).toBe("mail-1");
    expect(typeof body.took_ms).toBe("number");
  });

  it("fires insight.search.queried on every request", async () => {
    await GET(makeReq("?q=anything"));
    // emitInsight uses a fire-and-forget dynamic import on the
    // server path (keeps pg out of the client bundle). Flush the
    // microtask queue so the trackEvent call lands before assertions.
    await new Promise((r) => setTimeout(r, 0));
    const queriedCalls = mockTrackEvent.mock.calls.filter(
      ([name]) => name === "insight.search.queried",
    );
    expect(queriedCalls.length).toBe(1);
    const [, actor, role, metadata] = queriedCalls[0];
    expect(actor).toBe("u1");
    expect(role).toBe("ceo");
    expect(metadata).toEqual(
      expect.objectContaining({
        surface: "search",
        action: "queried",
        tier: "personal",
        query_length: "anything".length,
        total_results: 0,
      }),
    );
  });

  it("fires insight.search.no_results when nothing matches a non-empty query", async () => {
    await GET(makeReq("?q=zzzunknown"));
    await new Promise((r) => setTimeout(r, 0));
    const noResultsCalls = mockTrackEvent.mock.calls.filter(
      ([name]) => name === "insight.search.no_results",
    );
    expect(noResultsCalls.length).toBe(1);
    expect(noResultsCalls[0][3]).toEqual(
      expect.objectContaining({ surface: "search", action: "no_results", query: "zzzunknown" }),
    );
  });

  it("does NOT fire no_results when the query is empty (initial page load)", async () => {
    await GET(makeReq("?q="));
    const noResultsCalls = mockTrackEvent.mock.calls.filter(
      ([name]) => name === "insight.search.no_results",
    );
    expect(noResultsCalls.length).toBe(0);
  });

  it("respects the types= filter — only calls helpers for requested surfaces", async () => {
    await GET(makeReq("?q=hi&types=emails"));
    expect(mockFetchRecentEmails).toHaveBeenCalledTimes(1);
    expect(mockListChatsResult).not.toHaveBeenCalled();
    expect(mockFetchCalendarEvents).not.toHaveBeenCalled();
  });
});
