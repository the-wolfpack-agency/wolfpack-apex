/**
 * /api/mail/send + /api/mail/reply route tests.
 *
 * Covers: auth gate, rate limiting (30/hr), validation, analytics,
 * scope_missing passthrough.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

const mockGetUser = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...args: unknown[]) => mockGetUser(...args),
}));

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrack(...args),
}));

const mockSendMail = jest.fn();
const mockReply = jest.fn();
jest.mock("@/lib/integrations/microsoft-mail", () => ({
  sendMail: (...args: unknown[]) => mockSendMail(...args),
  replyToMessage: (...args: unknown[]) => mockReply(...args),
}));

const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...args: unknown[]) => mockRequireCapability(...args),
}));

const mockNotify = jest.fn().mockResolvedValue({ id: "n1" });
jest.mock("@/lib/notifications/in-app", () => ({
  notify: (...args: unknown[]) => mockNotify(...args),
}));

import { POST as sendPOST, _resetRateLimit } from "@/app/api/mail/send/route";
import { POST as replyPOST } from "@/app/api/mail/reply/route";

function mkReq(opts: { auth?: string; body?: unknown; url?: string } = {}) {
  const headers = new Headers();
  if (opts.auth) headers.set("authorization", opts.auth);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return new Request(opts.url ?? "http://test/api/mail/send", {
    method: "POST",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  }) as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimit();
  mockGetUser.mockReturnValue({ id: "u1", role: "cto" });
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "cto" }, capabilities: new Set() });
});

// ---------------------------------------------------------------------------
// /api/mail/send
// ---------------------------------------------------------------------------

describe("POST /api/mail/send", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValueOnce(null);
    const res = await sendPOST(mkReq({ body: { to: ["a@b.com"], subject: "x", bodyText: "y" } }));
    expect(res.status).toBe(401);
  });

  it("202 on success and returns { id, savedToSent }", async () => {
    mockSendMail.mockResolvedValueOnce({ ok: true, value: { id: "m1", savedToSent: true } });
    const res = await sendPOST(mkReq({ auth: "Bearer x", body: { to: ["a@b.com"], subject: "x", bodyText: "y" } }));
    expect(res.status).toBe(202);
    const data = await res.json();
    expect(data.id).toBe("m1");
    expect(data.savedToSent).toBe(true);
  });

  it("400 when `to` is missing", async () => {
    mockSendMail.mockResolvedValueOnce({ ok: false, code: "invalid_input", message: "to_required" });
    const res = await sendPOST(mkReq({ auth: "Bearer x", body: { subject: "x", bodyText: "y" } }));
    expect(res.status).toBe(400);
  });

  it("403 passes scope_missing + scope name through", async () => {
    mockSendMail.mockResolvedValueOnce({ ok: false, code: "scope_missing", scope: "Mail.Send", message: "no scope" });
    const res = await sendPOST(mkReq({ auth: "Bearer x", body: { to: ["a@b.com"], subject: "x", bodyText: "y" } }));
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.code).toBe("scope_missing");
    expect(data.scope).toBe("Mail.Send");
  });

  it("rate-limits after 30 calls/hr", async () => {
    mockSendMail.mockResolvedValue({ ok: true, value: { id: "m", savedToSent: true } });
    // 30 should pass, 31st is blocked
    for (let i = 0; i < 30; i++) {
      const r = await sendPOST(mkReq({ auth: "Bearer x", body: { to: ["a@b.com"], subject: "x", bodyText: "y" } }));
      expect(r.status).toBe(202);
    }
    const blocked = await sendPOST(mkReq({ auth: "Bearer x", body: { to: ["a@b.com"], subject: "x", bodyText: "y" } }));
    expect(blocked.status).toBe(429);
    const data = await blocked.json();
    expect(data.error).toBe("rate_limited");
    expect(typeof data.retryAfter).toBe("number");
    expect(mockTrack).toHaveBeenCalledWith(
      "system.upload_rate_limited",
      "u1",
      "cto",
      expect.objectContaining({ endpoint: "mail/send" }),
    );
  });

  it("401 on microsoft_not_connected", async () => {
    mockSendMail.mockResolvedValueOnce({ ok: false, code: "not_connected" });
    const res = await sendPOST(mkReq({ auth: "Bearer x", body: { to: ["a@b.com"], subject: "x", bodyText: "y" } }));
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// /api/mail/reply
// ---------------------------------------------------------------------------

describe("POST /api/mail/reply", () => {
  it("202 on reply success", async () => {
    mockReply.mockResolvedValueOnce({ ok: true, value: { id: "r1" } });
    const res = await replyPOST(mkReq({
      auth: "Bearer x",
      body: { originalMessageId: "orig-1", bodyText: "thanks" },
      url: "http://test/api/mail/reply",
    }));
    expect(res.status).toBe(202);
    const data = await res.json();
    expect(data.id).toBe("r1");
  });

  it("400 without originalMessageId", async () => {
    const res = await replyPOST(mkReq({ auth: "Bearer x", body: { bodyText: "hi" }, url: "http://test/api/mail/reply" }));
    expect(res.status).toBe(400);
  });
});
