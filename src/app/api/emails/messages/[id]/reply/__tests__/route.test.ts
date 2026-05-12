 
/**
 * POST /api/emails/[id]/reply — reply / replyAll / forward contract test.
 */

const mockGetUser = jest.fn();
const mockRequireCapability = jest.fn();
const mockReply = jest.fn();
const mockReplyAll = jest.fn();
const mockForward = jest.fn();
const mockSendRateLimited = jest.fn();

jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: any[]) => mockGetUser(...a),
}));
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/integrations/microsoft-mail", () => ({
  replyToMessage: (...a: any[]) => mockReply(...a),
  replyAllToMessage: (...a: any[]) => mockReplyAll(...a),
  forwardMessage: (...a: any[]) => mockForward(...a),
}));
jest.mock("@/app/api/mail/send/route", () => ({
  _isRateLimited: (...a: any[]) => mockSendRateLimited(...a),
}));

import { NextRequest } from "next/server";
import { POST } from "../route";

function makeReq(id: string, body: unknown, withAuth = true): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (withAuth) headers.authorization = "Bearer test-token";
  return new NextRequest(`https://x.test/api/emails/${id}/reply`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockReturnValue({ id: "u1", role: "ceo" });
  mockRequireCapability.mockResolvedValue({
    ok: true,
    user: { id: "u1", role: "ceo" },
    capabilities: new Set(["emails.send"]),
  });
  mockSendRateLimited.mockReturnValue({ limited: false, retryAfter: 0 });
});

describe("POST /api/emails/[id]/reply", () => {
  it("returns 401 unauth", async () => {
    mockGetUser.mockReturnValueOnce(null);
    const res = await POST(makeReq("x", { kind: "reply", bodyText: "hi" }, false), {
      params: Promise.resolve({ id: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 on missing kind", async () => {
    const res = await POST(makeReq("x", { bodyText: "hi" }), {
      params: Promise.resolve({ id: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 on missing body", async () => {
    const res = await POST(makeReq("x", { kind: "reply" }), {
      params: Promise.resolve({ id: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 forward without 'to'", async () => {
    const res = await POST(makeReq("x", { kind: "forward", bodyText: "FYI" }), {
      params: Promise.resolve({ id: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("calls replyToMessage on kind=reply", async () => {
    mockReply.mockResolvedValueOnce({ ok: true, value: { id: "reply-1" } });
    const res = await POST(makeReq("x", { kind: "reply", bodyText: "Thanks" }), {
      params: Promise.resolve({ id: "x" }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({ id: "reply-1", kind: "reply" });
    expect(mockReply).toHaveBeenCalled();
  });

  it("calls replyAllToMessage on kind=replyAll", async () => {
    mockReplyAll.mockResolvedValueOnce({ ok: true, value: { id: "rall-1" } });
    const res = await POST(makeReq("x", { kind: "replyAll", bodyText: "Thanks all" }), {
      params: Promise.resolve({ id: "x" }),
    });
    expect(res.status).toBe(202);
    expect(mockReplyAll).toHaveBeenCalled();
  });

  it("calls forwardMessage with parsed recipients", async () => {
    mockForward.mockResolvedValueOnce({ ok: true, value: { id: "fwd-1" } });
    const res = await POST(
      makeReq("x", {
        kind: "forward",
        bodyText: "FYI",
        to: ["a@x.co", "b@x.co"],
      }),
      { params: Promise.resolve({ id: "x" }) },
    );
    expect(res.status).toBe(202);
    expect(mockForward).toHaveBeenCalledWith(
      "u1",
      "x",
      ["a@x.co", "b@x.co"],
      expect.any(Object),
      "ceo",
    );
  });

  it("returns 403 scope_missing", async () => {
    mockReply.mockResolvedValueOnce({
      ok: false,
      code: "scope_missing",
      scope: "Mail.Send",
      status: 403,
    });
    const res = await POST(makeReq("x", { kind: "reply", bodyText: "x" }), {
      params: Promise.resolve({ id: "x" }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("scope_missing");
  });

  it("returns 502 on graph 5xx — never 500", async () => {
    mockReply.mockResolvedValueOnce({
      ok: false,
      code: "graph_error",
      status: 500,
      message: "boom",
    });
    const res = await POST(makeReq("x", { kind: "reply", bodyText: "x" }), {
      params: Promise.resolve({ id: "x" }),
    });
    expect(res.status).toBe(502);
  });

  it("returns 429 when send route rate-limit fires", async () => {
    mockSendRateLimited.mockReturnValueOnce({ limited: true, retryAfter: 11 });
    const res = await POST(makeReq("x", { kind: "reply", bodyText: "x" }), {
      params: Promise.resolve({ id: "x" }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("11");
  });
});
