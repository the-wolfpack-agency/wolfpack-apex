import { NextRequest } from "next/server";

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: jest.fn(),
}));
jest.mock("@/lib/support/repo", () => ({
  recordFeedback: jest.fn(),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));

const { requireCapability } = jest.requireMock("@/lib/auth/require-capability");
const repo = jest.requireMock("@/lib/support/repo");
const { trackEvent } = jest.requireMock("@/lib/analytics");

const user = { id: "u-1", email: "op@x.com", role: "dev" };

function unauth() {
  return {
    ok: false,
    response: new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
    }) as unknown as Response,
  };
}

function authed() {
  return { ok: true, user, capabilities: new Set() };
}

function req(body: unknown): NextRequest {
  return new NextRequest("http://t/api/support/tickets/tk-1/feedback", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = { params: Promise.resolve({ id: "tk-1" }) };

describe("POST /api/support/tickets/[id]/feedback", () => {
  beforeEach(() => jest.clearAllMocks());

  it("401 when auth fails", async () => {
    requireCapability.mockResolvedValue(unauth());
    const { POST } = await import("../tickets/[id]/feedback/route");
    const res = await POST(req({ helpful: true }), ctx);
    expect(res.status).toBe(401);
  });

  it("400 when helpful is missing or wrong type", async () => {
    requireCapability.mockResolvedValue(authed());
    const { POST } = await import("../tickets/[id]/feedback/route");
    const res = await POST(req({ notes: "no flag" }), ctx);
    expect(res.status).toBe(400);
    expect(repo.recordFeedback).not.toHaveBeenCalled();
  });

  it("404 when recordFeedback returns null", async () => {
    requireCapability.mockResolvedValue(authed());
    repo.recordFeedback.mockResolvedValue(null);
    const { POST } = await import("../tickets/[id]/feedback/route");
    const res = await POST(req({ helpful: true }), ctx);
    expect(res.status).toBe(404);
  });

  it("happy path with edit_diff fires support.feedback_submitted", async () => {
    requireCapability.mockResolvedValue(authed());
    repo.recordFeedback.mockResolvedValue({ id: "tk-1", helpful: false });
    const { POST } = await import("../tickets/[id]/feedback/route");
    const res = await POST(
      req({
        helpful: false,
        edit_diff: { added: ["one more line"] },
        notes: "rewrote intro",
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(repo.recordFeedback).toHaveBeenCalledWith(
      "tk-1",
      expect.objectContaining({
        helpful: false,
        edit_diff: { added: ["one more line"] },
        notes: "rewrote intro",
        reviewed_by_user_id: "u-1",
      }),
    );
    expect(trackEvent).toHaveBeenCalledWith(
      "support.feedback_submitted",
      "u-1",
      "dev",
      expect.objectContaining({
        ticket_id: "tk-1",
        helpful: false,
        has_edit_diff: true,
      }),
    );
  });

  it("500 when recordFeedback throws", async () => {
    requireCapability.mockResolvedValue(authed());
    repo.recordFeedback.mockRejectedValue(new Error("db lost"));
    const { POST } = await import("../tickets/[id]/feedback/route");
    const res = await POST(req({ helpful: true }), ctx);
    expect(res.status).toBe(500);
  });
});
