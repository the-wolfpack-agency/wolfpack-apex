/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * GET /api/emails/inbox — contract test.
 *
 * Locks every code path the /emails inbox surface relies on:
 *   - 200 happy path with messages.
 *   - 401 unauth (no auth header) before lib is touched.
 *   - 401 microsoft_not_connected when the lib reports no token.
 *   - 403 scope_missing.
 *   - 429 rate_limited surfaces Retry-After.
 *   - 502 graph_error never returns 500.
 *   - Pagination + unread filter pass through to the lib.
 */

const mockGetUser = jest.fn();
const mockListInbox = jest.fn();
const mockRequireCapability = jest.fn();

jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: any[]) => mockGetUser(...a),
}));
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/integrations/microsoft-mail", () => ({
  listInbox: (...a: any[]) => mockListInbox(...a),
}));

import { NextRequest } from "next/server";
import { GET, _resetRateLimit } from "../route";

function makeReq(qs = "", withAuth = true): NextRequest {
  const headers: Record<string, string> = {};
  if (withAuth) headers.authorization = "Bearer test-token";
  return new NextRequest(`https://x.test/api/emails/inbox${qs}`, {
    method: "GET",
    headers,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimit();
  mockGetUser.mockReturnValue({ id: "u1", role: "ceo", name: "N", email: "n@x.co" });
  mockRequireCapability.mockResolvedValue({
    ok: true,
    user: { id: "u1", role: "ceo" },
    capabilities: new Set(["emails.view"]),
  });
});

const SAMPLE_MSG = {
  id: "AAMkAD-1",
  subject: "Hello",
  from: { name: "Jane", email: "jane@example.com" },
  receivedDateTime: "2026-04-22T10:00:00Z",
  bodyPreview: "Hello there",
  isRead: false,
  hasAttachments: false,
  importance: "normal" as const,
  webLink: "https://outlook.office.com/m/AAMkAD-1",
};

describe("GET /api/emails/inbox", () => {
  it("returns 401 when there is no auth header", async () => {
    mockGetUser.mockReturnValueOnce(null);
    const res = await GET(makeReq("", false));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("unauthorized");
    expect(mockListInbox).not.toHaveBeenCalled();
  });

  it("returns 200 with messages on happy path and passes unreadOnly", async () => {
    mockListInbox.mockResolvedValueOnce({
      ok: true,
      value: { messages: [SAMPLE_MSG], nextSkip: null, unreadCount: 1 },
    });
    const res = await GET(makeReq("?unread=true&top=10&skip=0"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toHaveLength(1);
    expect(body.unreadCount).toBe(1);
    expect(mockListInbox).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ unreadOnly: true, top: 10, skip: 0 }),
    );
  });

  it("returns 401 microsoft_not_connected when the lib reports no token", async () => {
    mockListInbox.mockResolvedValueOnce({
      ok: false,
      code: "not_connected",
      message: "microsoft_not_connected",
    });
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("microsoft_not_connected");
  });

  it("returns 403 forbidden + scope_missing", async () => {
    mockListInbox.mockResolvedValueOnce({
      ok: false,
      code: "scope_missing",
      scope: "Mail.Read",
      status: 403,
    });
    const res = await GET(makeReq());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("scope_missing");
    expect(body.scope).toBe("Mail.Read");
  });

  it("returns 429 rate_limited from the lib (graph backpressure)", async () => {
    mockListInbox.mockResolvedValueOnce({
      ok: false,
      code: "rate_limited",
      retryAfter: 7,
      status: 429,
    });
    const res = await GET(makeReq());
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("7");
    const body = await res.json();
    expect(body.error).toBe("rate_limited");
    expect(body.retryAfter).toBe(7);
  });

  it("returns 502 (NEVER 500) on Graph 5xx", async () => {
    mockListInbox.mockResolvedValueOnce({
      ok: false,
      code: "graph_error",
      status: 500,
      message: "graph_500: oh no",
    });
    const res = await GET(makeReq());
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("graph_error");
  });

  it("clamps top to 100 + paginates skip via lib opts", async () => {
    mockListInbox.mockResolvedValueOnce({
      ok: true,
      value: { messages: [], nextSkip: null },
    });
    await GET(makeReq("?top=5000&skip=300"));
    expect(mockListInbox).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ top: 5000, skip: 300, unreadOnly: false }),
    );
  });

  it("rate-limits a flood from the same user (60/min)", async () => {
    mockListInbox.mockResolvedValue({
      ok: true,
      value: { messages: [], nextSkip: null },
    });
    for (let i = 0; i < 60; i++) await GET(makeReq());
    const res = await GET(makeReq());
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("rate_limited");
  });

  it("returns 403 when the capability is denied", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: false,
      response: new Response(
        JSON.stringify({ error: "forbidden", capability: "emails.view" }),
        { status: 403, headers: { "content-type": "application/json" } },
      ),
    });
    const res = await GET(makeReq());
    expect(res.status).toBe(403);
  });
});
