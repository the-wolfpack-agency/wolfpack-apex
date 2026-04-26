/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * GET /api/mail/[id] — read-single-message route contract.
 *
 * Locks every code path the /emails?id=<id> deep-link can hit:
 *   - 200 happy path returns the normalized message.
 *   - 401 unauth (no auth header).
 *   - 401 microsoft_not_connected when the lib reports no token.
 *   - 403 scope_missing (Mail.Read absent on the user's token).
 *   - 404 not_found (Graph rejected the id).
 *   - 429 rate_limited surfaces Retry-After.
 *   - 500/502 graph_error carries through.
 *   - 400 invalid_input on empty id.
 *
 * Mocks the lib helper so the test runs offline + deterministic.
 */

const mockGetUser = jest.fn();
const mockGetMessage = jest.fn();

jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: any[]) => mockGetUser(...a),
}));
jest.mock("@/lib/integrations/microsoft-mail", () => ({
  getMessage: (...a: any[]) => mockGetMessage(...a),
}));

import { NextRequest } from "next/server";
import { GET } from "../route";

function makeReq(id: string, withAuth: boolean = true): NextRequest {
  const headers: Record<string, string> = {};
  if (withAuth) headers.authorization = "Bearer test-token";
  return new NextRequest(`https://x.test/api/mail/${id}`, {
    method: "GET",
    headers,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockReturnValue({ id: "u1", role: "ceo", name: "N", email: "n@x.co" });
});

const SAMPLE = {
  id: "AAMkAD-message-1",
  subject: "Q2 Retainer",
  from: { name: "James Greenfield", email: "james@greenfield.test" },
  toRecipients: [{ name: "Nick", email: "nick@wolfpack.test" }],
  ccRecipients: [],
  receivedDateTime: "2026-04-22T10:00:00Z",
  bodyContentType: "html",
  bodyContent: "<p>Legal approved the SOW.</p>",
  bodyPreview: "Legal approved the SOW.",
  webLink: "https://outlook.office.com/m/AAMkAD-1",
};

describe("GET /api/mail/[id]", () => {
  it("returns 401 when there is no auth header", async () => {
    mockGetUser.mockReturnValueOnce(null);
    const res = await GET(makeReq("anything", false), { params: Promise.resolve({ id: "anything" }) });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("unauthorized");
    expect(mockGetMessage).not.toHaveBeenCalled();
  });

  it("returns 400 when the id is empty / whitespace", async () => {
    const res = await GET(makeReq("   "), { params: Promise.resolve({ id: "   " }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_input");
    expect(mockGetMessage).not.toHaveBeenCalled();
  });

  it("returns 200 with the normalized message on happy path", async () => {
    mockGetMessage.mockResolvedValueOnce({ ok: true, value: SAMPLE });
    const res = await GET(makeReq("AAMkAD-message-1"), { params: Promise.resolve({ id: "AAMkAD-message-1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toEqual(SAMPLE);
    expect(mockGetMessage).toHaveBeenCalledWith("u1", "AAMkAD-message-1");
  });

  it("returns 401 microsoft_not_connected when the lib reports no token", async () => {
    mockGetMessage.mockResolvedValueOnce({
      ok: false,
      code: "not_connected",
      message: "microsoft_not_connected",
    });
    const res = await GET(makeReq("x"), { params: Promise.resolve({ id: "x" }) });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("microsoft_not_connected");
  });

  it("returns 403 scope_missing with the Mail.Read scope name", async () => {
    mockGetMessage.mockResolvedValueOnce({
      ok: false,
      code: "scope_missing",
      scope: "Mail.Read",
      status: 403,
      message: "AccessDenied",
    });
    const res = await GET(makeReq("x"), { params: Promise.resolve({ id: "x" }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("forbidden");
    expect(body.code).toBe("scope_missing");
    expect(body.scope).toBe("Mail.Read");
  });

  it("returns 404 not_found when Graph rejects the id", async () => {
    mockGetMessage.mockResolvedValueOnce({
      ok: false,
      code: "graph_error",
      status: 404,
      message: "not_found",
    });
    const res = await GET(makeReq("missing"), { params: Promise.resolve({ id: "missing" }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_found");
  });

  it("returns 429 rate_limited and surfaces Retry-After", async () => {
    mockGetMessage.mockResolvedValueOnce({
      ok: false,
      code: "rate_limited",
      retryAfter: 7,
      status: 429,
      message: "rate_limited",
    });
    const res = await GET(makeReq("x"), { params: Promise.resolve({ id: "x" }) });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("7");
    const body = await res.json();
    expect(body.error).toBe("rate_limited");
    expect(body.retryAfter).toBe(7);
  });

  it("returns 502 graph_error for non-404 graph failures", async () => {
    mockGetMessage.mockResolvedValueOnce({
      ok: false,
      code: "graph_error",
      status: 500,
      message: "graph_500: outage",
    });
    const res = await GET(makeReq("x"), { params: Promise.resolve({ id: "x" }) });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("graph_error");
    expect(body.message).toContain("graph_500");
  });
});
