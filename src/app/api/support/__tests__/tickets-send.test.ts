import { NextRequest } from "next/server";

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: jest.fn(),
}));
jest.mock("@/lib/support/repo", () => ({
  getTicket: jest.fn(),
  updateTicket: jest.fn(),
  appendTicketReply: jest.fn(),
}));
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: jest.fn(),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));

const { requireCapability } = jest.requireMock("@/lib/auth/require-capability");
const repo = jest.requireMock("@/lib/support/repo");
const { getValidToken } = jest.requireMock("@/lib/microsoft-graph");
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
  return new NextRequest("http://t/api/support/tickets/tk-1/send", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = { params: Promise.resolve({ id: "tk-1" }) };

const ticket = {
  id: "tk-1",
  title: "Login broken",
  body: "u can't log in",
  draft_response: "Hi there, here is your draft.\nThe Wolfpack Team",
  sent_response: null,
};

describe("POST /api/support/tickets/[id]/send", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("401 when auth fails", async () => {
    requireCapability.mockResolvedValue(unauth());
    const { POST } = await import("../tickets/[id]/send/route");
    const res = await POST(req({ to_email: "user@example.com" }), ctx);
    expect(res.status).toBe(401);
  });

  it("400 when to_email is missing or malformed", async () => {
    requireCapability.mockResolvedValue(authed());
    const { POST } = await import("../tickets/[id]/send/route");
    const res = await POST(req({ to_email: "not-an-email" }), ctx);
    expect(res.status).toBe(400);
    expect(repo.getTicket).not.toHaveBeenCalled();
  });

  it("502 with no_token when getValidToken returns null", async () => {
    requireCapability.mockResolvedValue(authed());
    repo.getTicket.mockResolvedValue(ticket);
    getValidToken.mockResolvedValue(null);
    const { POST } = await import("../tickets/[id]/send/route");
    const res = await POST(req({ to_email: "user@example.com" }), ctx);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("no_token");
    expect(repo.updateTicket).not.toHaveBeenCalled();
  });

  it("502 with no_token when Graph returns 401", async () => {
    requireCapability.mockResolvedValue(authed());
    repo.getTicket.mockResolvedValue(ticket);
    getValidToken.mockResolvedValue({ accessToken: "tk", userEmail: "op@x.com" });
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    );
    const { POST } = await import("../tickets/[id]/send/route");
    const res = await POST(req({ to_email: "user@example.com" }), ctx);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("no_token");
    expect(repo.updateTicket).not.toHaveBeenCalled();
  });

  it("502 with graph_error when Graph returns 500", async () => {
    requireCapability.mockResolvedValue(authed());
    repo.getTicket.mockResolvedValue(ticket);
    getValidToken.mockResolvedValue({ accessToken: "tk", userEmail: "op@x.com" });
    global.fetch = jest.fn().mockResolvedValue(
      new Response("upstream broke", { status: 500 }),
    );
    const { POST } = await import("../tickets/[id]/send/route");
    const res = await POST(req({ to_email: "user@example.com" }), ctx);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("graph_error");
    expect(repo.updateTicket).not.toHaveBeenCalled();
  });

  it("Graph 202 → ticket marked sent + analytics fired + From=support@", async () => {
    requireCapability.mockResolvedValue(authed());
    repo.getTicket.mockResolvedValue(ticket);
    repo.updateTicket.mockResolvedValue({ ...ticket, status: "sent" });
    getValidToken.mockResolvedValue({ accessToken: "tk", userEmail: "op@x.com" });
    const fetchMock = jest.fn().mockResolvedValue(
      new Response(null, { status: 202 }),
    );
    global.fetch = fetchMock;

    const { POST } = await import("../tickets/[id]/send/route");
    const res = await POST(req({ to_email: "user@example.com" }), ctx);
    expect(res.status).toBe(200);

    const sentPayload = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sentPayload.message.from.emailAddress.address).toBe(
      "support@thewolfpack.agency",
    );
    expect(sentPayload.message.toRecipients[0].emailAddress.address).toBe(
      "user@example.com",
    );

    expect(repo.updateTicket).toHaveBeenCalledWith(
      "tk-1",
      expect.objectContaining({
        status: "sent",
        sent_to_email: "user@example.com",
        sent_response: ticket.draft_response,
      }),
    );
    expect(trackEvent).toHaveBeenCalledWith(
      "support.ticket_sent",
      "u-1",
      "dev",
      expect.objectContaining({
        ticket_id: "tk-1",
        to_email: "user@example.com",
      }),
    );
  });

  it("uses /messages/{id}/reply when ticket has graph_message_id (thread preservation)", async () => {
    requireCapability.mockResolvedValue(authed());
    repo.getTicket.mockResolvedValue({
      ...ticket,
      graph_message_id: "graph-msg-abc",
      graph_conversation_id: "conv-1",
    });
    repo.updateTicket.mockResolvedValue({ ...ticket, status: "sent" });
    repo.appendTicketReply.mockResolvedValue("reply-row-1");
    getValidToken.mockResolvedValue({ accessToken: "tk", userEmail: "op@x.com" });
    const fetchMock = jest.fn().mockResolvedValue(new Response(null, { status: 202 }));
    global.fetch = fetchMock;

    const { POST } = await import("../tickets/[id]/send/route");
    const res = await POST(req({ to_email: "user@example.com" }), ctx);
    expect(res.status).toBe(200);

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe(
      "https://graph.microsoft.com/v1.0/me/messages/graph-msg-abc/reply",
    );

    /* /reply payload uses `comment` not `message.body.content`. */
    const sentPayload = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sentPayload.comment).toBe(ticket.draft_response);
    expect(sentPayload.message.toRecipients[0].emailAddress.address).toBe(
      "user@example.com",
    );
    expect(sentPayload.message.from).toBeUndefined();

    /* Outbound row appended to the audit table. */
    expect(repo.appendTicketReply).toHaveBeenCalledWith(
      "tk-1",
      expect.objectContaining({
        direction: "outbound",
        from_email: "support@thewolfpack.agency",
      }),
    );

    /* Analytics carries the send_path discriminator. */
    expect(trackEvent).toHaveBeenCalledWith(
      "support.ticket_sent",
      "u-1",
      "dev",
      expect.objectContaining({ send_path: "reply" }),
    );
  });

  it("uses overrides for subject + body when provided", async () => {
    requireCapability.mockResolvedValue(authed());
    repo.getTicket.mockResolvedValue(ticket);
    repo.updateTicket.mockResolvedValue({ ...ticket, status: "sent" });
    getValidToken.mockResolvedValue({ accessToken: "tk", userEmail: "op@x.com" });
    const fetchMock = jest.fn().mockResolvedValue(
      new Response(null, { status: 202 }),
    );
    global.fetch = fetchMock;

    const { POST } = await import("../tickets/[id]/send/route");
    await POST(
      req({
        to_email: "user@example.com",
        subject: "Custom subject",
        body: "Edited body before send.",
      }),
      ctx,
    );

    const sentPayload = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sentPayload.message.subject).toBe("Custom subject");
    expect(sentPayload.message.body.content).toBe("Edited body before send.");
  });
});
