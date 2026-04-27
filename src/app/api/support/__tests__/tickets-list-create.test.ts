import { NextRequest } from "next/server";

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: jest.fn(),
}));
jest.mock("@/lib/support/repo", () => ({
  createTicket: jest.fn(),
  listTickets: jest.fn(),
  updateTicket: jest.fn(),
  listEnabledPatterns: jest.fn(),
}));
jest.mock("@/lib/support/pattern-library", () => ({
  findMatchingPatterns: jest.fn(),
  generateDraftResponse: jest.fn(),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));

const { requireCapability } = jest.requireMock("@/lib/auth/require-capability");
const repo = jest.requireMock("@/lib/support/repo");
const patternLib = jest.requireMock("@/lib/support/pattern-library");
const { trackEvent } = jest.requireMock("@/lib/analytics");

const user = { id: "u-1", email: "op@x.com", role: "dev" };

function unauth(): { ok: false; response: Response } {
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

function req(method: "GET" | "POST", url: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: body === undefined ? null : JSON.stringify(body),
  });
}

const ticketRow = {
  id: "tk-1",
  title: "t",
  body: "b",
  diagnostic_text: null,
  category: "other",
  severity: "p3",
  status: "drafted",
  audience: "internal",
  created_by_user_id: "u-1",
  created_by_email: "op@x.com",
  draft_response: "Hi there, here is your draft.",
  draft_generated_at: "2026-04-27T00:00:00Z",
  draft_pattern_ids: [],
  sent_response: null,
  sent_at: null,
  sent_to_email: null,
  helpful: null,
  edit_diff: null,
  feedback_notes: null,
  feedback_at: null,
  created_at: "2026-04-27T00:00:00Z",
  updated_at: "2026-04-27T00:00:00Z",
};

describe("GET /api/support/tickets", () => {
  beforeEach(() => jest.clearAllMocks());

  it("401 when auth fails", async () => {
    requireCapability.mockResolvedValue(unauth());
    const { GET } = await import("../tickets/route");
    const res = await GET(req("GET", "http://t/api/support/tickets"));
    expect(res.status).toBe(401);
  });

  it("returns tickets + total + fires support.list_viewed", async () => {
    requireCapability.mockResolvedValue(authed());
    repo.listTickets.mockResolvedValue([ticketRow]);
    const { GET } = await import("../tickets/route");
    const res = await GET(req("GET", "http://t/api/support/tickets?status=open"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tickets).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(repo.listTickets).toHaveBeenCalledWith({
      status: "open",
      category: undefined,
      audience: undefined,
      limit: 50,
    });
    expect(trackEvent).toHaveBeenCalledWith(
      "support.list_viewed",
      "u-1",
      "dev",
      expect.objectContaining({ count: 1 }),
    );
  });

  it("ignores invalid status param and falls back to undefined", async () => {
    requireCapability.mockResolvedValue(authed());
    repo.listTickets.mockResolvedValue([]);
    const { GET } = await import("../tickets/route");
    await GET(req("GET", "http://t/api/support/tickets?status=garbage"));
    expect(repo.listTickets).toHaveBeenCalledWith(
      expect.objectContaining({ status: undefined }),
    );
  });

  it("500 when repo throws", async () => {
    requireCapability.mockResolvedValue(authed());
    repo.listTickets.mockRejectedValue(new Error("db down"));
    const { GET } = await import("../tickets/route");
    const res = await GET(req("GET", "http://t/api/support/tickets"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("db down");
  });
});

describe("POST /api/support/tickets", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    repo.listEnabledPatterns.mockResolvedValue([]);
    patternLib.findMatchingPatterns.mockReturnValue([]);
    patternLib.generateDraftResponse.mockResolvedValue({
      ok: true,
      draft: "Hello, here is your draft.",
      pattern_ids: [],
      from_cache: false,
      tokens_used: 50,
    });
  });

  it("401 when auth fails", async () => {
    requireCapability.mockResolvedValue(unauth());
    const { POST } = await import("../tickets/route");
    const res = await POST(
      req("POST", "http://t/api/support/tickets", { title: "t", body: "b" }),
    );
    expect(res.status).toBe(401);
  });

  it("400 when title or body missing", async () => {
    requireCapability.mockResolvedValue(authed());
    const { POST } = await import("../tickets/route");
    const res = await POST(
      req("POST", "http://t/api/support/tickets", { title: "", body: "" }),
    );
    expect(res.status).toBe(400);
    expect(repo.createTicket).not.toHaveBeenCalled();
  });

  it("creates ticket, generates draft, returns updated row + tracks event", async () => {
    requireCapability.mockResolvedValue(authed());
    repo.createTicket.mockResolvedValue(ticketRow);
    repo.updateTicket.mockResolvedValue({ ...ticketRow, status: "drafted" });
    const { POST } = await import("../tickets/route");
    const res = await POST(
      req("POST", "http://t/api/support/tickets", {
        title: "Login broken",
        body: "User cannot log in",
        category: "auth",
        severity: "p2",
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe("tk-1");
    expect(repo.createTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Login broken",
        body: "User cannot log in",
        created_by_user_id: "u-1",
        created_by_email: "op@x.com",
        status: "open",
      }),
    );
    expect(repo.updateTicket).toHaveBeenCalledWith(
      "tk-1",
      expect.objectContaining({
        status: "drafted",
        draft_response: "Hello, here is your draft.",
      }),
    );
    expect(trackEvent).toHaveBeenCalledWith(
      "support.ticket_created",
      "u-1",
      "dev",
      expect.objectContaining({ ticket_id: "tk-1", category: "auth" }),
    );
  });

  it("500 when createTicket throws", async () => {
    requireCapability.mockResolvedValue(authed());
    repo.createTicket.mockRejectedValue(new Error("constraint violation"));
    const { POST } = await import("../tickets/route");
    const res = await POST(
      req("POST", "http://t/api/support/tickets", { title: "t", body: "b" }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("constraint violation");
  });

  it("400 when audience is not 'client' or 'internal'", async () => {
    requireCapability.mockResolvedValue(authed());
    const { POST } = await import("../tickets/route");
    const res = await POST(
      req("POST", "http://t/api/support/tickets", {
        title: "t",
        body: "b",
        audience: "vendor",
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_audience");
    expect(repo.createTicket).not.toHaveBeenCalled();
  });
});

describe("GET /api/support/tickets — audience filter", () => {
  beforeEach(() => jest.clearAllMocks());

  it("forwards ?audience=client to listTickets and returns the filtered set", async () => {
    requireCapability.mockResolvedValue(authed());
    const clientRow = { ...ticketRow, id: "tk-c1", audience: "client" };
    repo.listTickets.mockResolvedValue([clientRow]);
    const { GET } = await import("../tickets/route");
    const res = await GET(
      req("GET", "http://t/api/support/tickets?audience=client"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tickets).toHaveLength(1);
    expect(body.tickets[0].audience).toBe("client");
    expect(repo.listTickets).toHaveBeenCalledWith(
      expect.objectContaining({ audience: "client" }),
    );
  });
});
