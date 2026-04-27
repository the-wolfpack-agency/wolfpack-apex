import { NextRequest } from "next/server";

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: jest.fn(),
}));
jest.mock("@/lib/support/repo", () => ({
  getTicket: jest.fn(),
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

function req(): NextRequest {
  return new NextRequest("http://t/api/support/tickets/tk-1/draft", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
  });
}

const ctx = { params: Promise.resolve({ id: "tk-1" }) };

const ticket = {
  id: "tk-1",
  title: "t",
  body: "AADSTS50012 happens",
  diagnostic_text: "stack trace here",
};

describe("POST /api/support/tickets/[id]/draft", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    repo.listEnabledPatterns.mockResolvedValue([]);
    patternLib.findMatchingPatterns.mockReturnValue([
      { id: "p-1", slug: "aad-error" },
    ]);
    patternLib.generateDraftResponse.mockResolvedValue({
      ok: true,
      draft: "Friendly draft",
      pattern_ids: ["p-1"],
      from_cache: false,
      tokens_used: 10,
    });
  });

  it("401 when auth fails", async () => {
    requireCapability.mockResolvedValue(unauth());
    const { POST } = await import("../tickets/[id]/draft/route");
    const res = await POST(req(), ctx);
    expect(res.status).toBe(401);
  });

  it("404 when ticket not found", async () => {
    requireCapability.mockResolvedValue(authed());
    repo.getTicket.mockResolvedValue(null);
    const { POST } = await import("../tickets/[id]/draft/route");
    const res = await POST(req(), ctx);
    expect(res.status).toBe(404);
  });

  it("regenerates draft, persists drafted state, fires support.draft_generated", async () => {
    requireCapability.mockResolvedValue(authed());
    repo.getTicket.mockResolvedValue(ticket);
    repo.updateTicket.mockResolvedValue({ ...ticket, status: "drafted" });
    const { POST } = await import("../tickets/[id]/draft/route");
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(repo.updateTicket).toHaveBeenCalledWith(
      "tk-1",
      expect.objectContaining({
        status: "drafted",
        draft_response: "Friendly draft",
        draft_pattern_ids: ["p-1"],
      }),
    );
    expect(trackEvent).toHaveBeenCalledWith(
      "support.draft_generated",
      "u-1",
      "dev",
      expect.objectContaining({ ticket_id: "tk-1", char_count: 14 }),
    );
  });

  it("still updates ticket when draft generation fails (draft=null)", async () => {
    requireCapability.mockResolvedValue(authed());
    repo.getTicket.mockResolvedValue(ticket);
    repo.updateTicket.mockResolvedValue({ ...ticket, draft_response: null });
    patternLib.generateDraftResponse.mockResolvedValue({
      ok: false,
      error_detail: "no api key",
      pattern_ids: [],
    });
    const { POST } = await import("../tickets/[id]/draft/route");
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(repo.updateTicket).toHaveBeenCalledWith(
      "tk-1",
      expect.objectContaining({ draft_response: null }),
    );
  });

  it("500 when getTicket throws", async () => {
    requireCapability.mockResolvedValue(authed());
    repo.getTicket.mockRejectedValue(new Error("db oops"));
    const { POST } = await import("../tickets/[id]/draft/route");
    const res = await POST(req(), ctx);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("db oops");
  });
});
