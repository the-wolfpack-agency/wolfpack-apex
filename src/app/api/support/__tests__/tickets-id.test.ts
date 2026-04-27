import { NextRequest } from "next/server";

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: jest.fn(),
}));
jest.mock("@/lib/support/repo", () => ({
  getTicket: jest.fn(),
  updateTicket: jest.fn(),
  deleteTicket: jest.fn(),
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
      headers: { "content-type": "application/json" },
    }) as unknown as Response,
  };
}

function authed() {
  return { ok: true, user, capabilities: new Set() };
}

function req(method: "GET" | "PATCH" | "DELETE", body?: unknown): NextRequest {
  return new NextRequest("http://t/api/support/tickets/tk-1", {
    method,
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: body === undefined ? null : JSON.stringify(body),
  });
}

const ctx = { params: Promise.resolve({ id: "tk-1" }) };

const ticket = {
  id: "tk-1",
  title: "t",
  body: "b",
  status: "open",
};

describe("GET /api/support/tickets/[id]", () => {
  beforeEach(() => jest.clearAllMocks());

  it("401 when auth fails", async () => {
    requireCapability.mockResolvedValue(unauth());
    const { GET } = await import("../tickets/[id]/route");
    const res = await GET(req("GET"), ctx);
    expect(res.status).toBe(401);
  });

  it("404 when ticket missing", async () => {
    requireCapability.mockResolvedValue(authed());
    repo.getTicket.mockResolvedValue(null);
    const { GET } = await import("../tickets/[id]/route");
    const res = await GET(req("GET"), ctx);
    expect(res.status).toBe(404);
  });

  it("200 returns ticket", async () => {
    requireCapability.mockResolvedValue(authed());
    repo.getTicket.mockResolvedValue(ticket);
    const { GET } = await import("../tickets/[id]/route");
    const res = await GET(req("GET"), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticket).toEqual(ticket);
  });

  it("500 when repo throws", async () => {
    requireCapability.mockResolvedValue(authed());
    repo.getTicket.mockRejectedValue(new Error("oops"));
    const { GET } = await import("../tickets/[id]/route");
    const res = await GET(req("GET"), ctx);
    expect(res.status).toBe(500);
  });
});

describe("PATCH /api/support/tickets/[id]", () => {
  beforeEach(() => jest.clearAllMocks());

  it("401 when auth fails", async () => {
    requireCapability.mockResolvedValue(unauth());
    const { PATCH } = await import("../tickets/[id]/route");
    const res = await PATCH(req("PATCH", { title: "x" }), ctx);
    expect(res.status).toBe(401);
  });

  it("400 when no patchable fields supplied", async () => {
    requireCapability.mockResolvedValue(authed());
    const { PATCH } = await import("../tickets/[id]/route");
    const res = await PATCH(req("PATCH", { not_a_field: 1 }), ctx);
    expect(res.status).toBe(400);
    expect(repo.updateTicket).not.toHaveBeenCalled();
  });

  it("updates only allowed fields and tracks event", async () => {
    requireCapability.mockResolvedValue(authed());
    repo.updateTicket.mockResolvedValue({ ...ticket, title: "new" });
    const { PATCH } = await import("../tickets/[id]/route");
    const res = await PATCH(
      req("PATCH", { title: "new", body: "newb", junk: "ignored" }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(repo.updateTicket).toHaveBeenCalledWith("tk-1", {
      title: "new",
      body: "newb",
    });
    expect(trackEvent).toHaveBeenCalledWith(
      "support.ticket_updated",
      "u-1",
      "dev",
      expect.objectContaining({
        ticket_id: "tk-1",
        fields_changed: "title,body",
      }),
    );
  });

  it("404 when repo returns null", async () => {
    requireCapability.mockResolvedValue(authed());
    repo.updateTicket.mockResolvedValue(null);
    const { PATCH } = await import("../tickets/[id]/route");
    const res = await PATCH(req("PATCH", { title: "x" }), ctx);
    expect(res.status).toBe(404);
  });

  it("500 when repo throws", async () => {
    requireCapability.mockResolvedValue(authed());
    repo.updateTicket.mockRejectedValue(new Error("boom"));
    const { PATCH } = await import("../tickets/[id]/route");
    const res = await PATCH(req("PATCH", { title: "x" }), ctx);
    expect(res.status).toBe(500);
  });
});

describe("DELETE /api/support/tickets/[id]", () => {
  beforeEach(() => jest.clearAllMocks());

  it("401 when auth fails", async () => {
    requireCapability.mockResolvedValue(unauth());
    const { DELETE } = await import("../tickets/[id]/route");
    const res = await DELETE(req("DELETE"), ctx);
    expect(res.status).toBe(401);
  });

  it("200 ok:true when delete succeeds", async () => {
    requireCapability.mockResolvedValue(authed());
    repo.deleteTicket.mockResolvedValue(true);
    const { DELETE } = await import("../tickets/[id]/route");
    const res = await DELETE(req("DELETE"), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("404 when delete returns false", async () => {
    requireCapability.mockResolvedValue(authed());
    repo.deleteTicket.mockResolvedValue(false);
    const { DELETE } = await import("../tickets/[id]/route");
    const res = await DELETE(req("DELETE"), ctx);
    expect(res.status).toBe(404);
  });
});
