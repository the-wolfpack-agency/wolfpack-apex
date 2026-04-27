import { NextRequest } from "next/server";

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: jest.fn(),
}));
jest.mock("@/lib/support/repo", () => ({
  createTicket: jest.fn(),
  listTickets: jest.fn(),
  updateTicket: jest.fn(),
  listEnabledPatterns: jest.fn(),
  setTicketCategory: jest.fn(),
}));
jest.mock("@/lib/support/pattern-library", () => ({
  findMatchingPatterns: jest.fn(),
  generateDraftResponse: jest.fn(),
}));
jest.mock("@/lib/support/categorizer", () => ({
  categorizeTicket: jest.fn(),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));

const { requireCapability } = jest.requireMock("@/lib/auth/require-capability");
const repo = jest.requireMock("@/lib/support/repo");
const patternLib = jest.requireMock("@/lib/support/pattern-library");
const categorizer = jest.requireMock("@/lib/support/categorizer");
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
    repo.setTicketCategory.mockResolvedValue(undefined);
    patternLib.findMatchingPatterns.mockReturnValue([]);
    patternLib.generateDraftResponse.mockResolvedValue({
      ok: true,
      draft: "Hello, here is your draft.",
      pattern_ids: [],
      from_cache: false,
      tokens_used: 50,
    });
    /* Default categorizer return: confident m365 pick. Tests that
       care about specific categories override this. */
    categorizer.categorizeTicket.mockResolvedValue({
      category: "m365",
      confidence: 0.93,
      reasoning: "AADSTS error in title",
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

  it("auto-categorizes when no category is provided, persists via setTicketCategory, and tracks support.categorized", async () => {
    requireCapability.mockResolvedValue(authed());
    repo.createTicket.mockResolvedValue({ ...ticketRow, category: "general" });
    repo.updateTicket.mockResolvedValue({ ...ticketRow, status: "drafted" });
    categorizer.categorizeTicket.mockResolvedValueOnce({
      category: "m365",
      confidence: 0.94,
      reasoning: "AADSTS50126 error",
    });

    const { POST } = await import("../tickets/route");
    const res = await POST(
      req("POST", "http://t/api/support/tickets", {
        title: "Cannot sign in to Outlook",
        body: "User keeps getting AADSTS50126 every time.",
      }),
    );
    expect(res.status).toBe(201);

    /* The categorizer ran and was called with the ticket title + body. */
    expect(categorizer.categorizeTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Cannot sign in to Outlook",
        body: "User keeps getting AADSTS50126 every time.",
      }),
    );

    /* setTicketCategory was called with source='ai' + the model's pick. */
    expect(repo.setTicketCategory).toHaveBeenCalledWith(
      "tk-1",
      "m365",
      "ai",
      0.94,
    );

    /* support.categorized event fired with the new metadata. */
    expect(trackEvent).toHaveBeenCalledWith(
      "support.categorized",
      "u-1",
      "dev",
      expect.objectContaining({
        ticket_id: "tk-1",
        category: "m365",
        confidence: 0.94,
        source: "ai",
      }),
    );
  });

  it("does NOT auto-categorize when the operator provided a real category", async () => {
    requireCapability.mockResolvedValue(authed());
    repo.createTicket.mockResolvedValue({ ...ticketRow, category: "auth" });
    repo.updateTicket.mockResolvedValue({ ...ticketRow, status: "drafted" });

    const { POST } = await import("../tickets/route");
    await POST(
      req("POST", "http://t/api/support/tickets", {
        title: "x",
        body: "y",
        category: "auth",
      }),
    );

    expect(categorizer.categorizeTicket).not.toHaveBeenCalled();
    expect(repo.setTicketCategory).not.toHaveBeenCalled();
  });

  it("does auto-categorize when the operator passed category='general'", async () => {
    requireCapability.mockResolvedValue(authed());
    repo.createTicket.mockResolvedValue({ ...ticketRow, category: "general" });
    repo.updateTicket.mockResolvedValue({ ...ticketRow, status: "drafted" });

    const { POST } = await import("../tickets/route");
    await POST(
      req("POST", "http://t/api/support/tickets", {
        title: "x",
        body: "y",
        category: "general",
      }),
    );

    expect(categorizer.categorizeTicket).toHaveBeenCalled();
    expect(repo.setTicketCategory).toHaveBeenCalled();
  });

  it("ticket creation succeeds even when the categorizer throws", async () => {
    requireCapability.mockResolvedValue(authed());
    repo.createTicket.mockResolvedValue({ ...ticketRow, category: "general" });
    repo.updateTicket.mockResolvedValue({ ...ticketRow, status: "drafted" });
    categorizer.categorizeTicket.mockRejectedValueOnce(new Error("ai down"));
    /* Categorizer never throws (it has its own catch), but
       setTicketCategory might. Spec: failure here MUST NOT block
       ticket creation. */
    repo.setTicketCategory.mockRejectedValueOnce(new Error("db hiccup"));

    const consoleSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const { POST } = await import("../tickets/route");
    const res = await POST(
      req("POST", "http://t/api/support/tickets", { title: "x", body: "y" }),
    );
    expect(res.status).toBe(201);
    consoleSpy.mockRestore();
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
