/**
 * support/inbox-poller — unit tests.
 *
 * Mocks @/lib/microsoft-graph, @/lib/support/repo, @/lib/support/pattern-library,
 * @/lib/db, @/lib/analytics + global.fetch so we drive every branch
 * without infrastructure. Verifies:
 *   - no token → skipped:'no_valid_token', no Graph call
 *   - empty payload → counters stay at 0
 *   - 2 fresh messages → 2 tickets created with audience='client', drafts persisted
 *   - conversationId match → appendTicketReply, NO ticket-create
 *   - Graph 401 → skipped:'no_valid_token', cursor not advanced
 *   - Graph 5xx → errors=1, cursor not advanced
 *   - cursor advances on success to the newest receivedDateTime seen
 *   - cursor does NOT advance when a fresh fetch fails
 *   - SUPPORT_INBOX_MAILBOX_UPN routes to /users/<upn>
 *   - HTML body strips tags via cheerio
 */

const mockGetValidToken = jest.fn();
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...args: unknown[]) => mockGetValidToken(...args),
}));

const mockCreateTicket = jest.fn();
const mockUpdateTicket = jest.fn();
const mockFindByConv = jest.fn();
const mockAppendReply = jest.fn();
const mockListPatterns = jest.fn();
jest.mock("@/lib/support/repo", () => ({
  createTicket: (...args: unknown[]) => mockCreateTicket(...args),
  updateTicket: (...args: unknown[]) => mockUpdateTicket(...args),
  findTicketByConversationId: (...args: unknown[]) => mockFindByConv(...args),
  appendTicketReply: (...args: unknown[]) => mockAppendReply(...args),
  listEnabledPatterns: (...args: unknown[]) => mockListPatterns(...args),
}));

const mockFindMatching = jest.fn();
const mockGenerateDraft = jest.fn();
jest.mock("@/lib/support/pattern-library", () => ({
  findMatchingPatterns: (...args: unknown[]) => mockFindMatching(...args),
  generateDraftResponse: (...args: unknown[]) => mockGenerateDraft(...args),
}));

const mockQuery = jest.fn();
const mockWriteQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  writeQuery: (...args: unknown[]) => mockWriteQuery(...args),
  WriteQueryError: class extends Error {},
}));

jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));

import {
  pollSupportInbox,
  getSupportMailboxBase,
  messageBodyToPlainText,
  messageToTicket,
  extractDiagnosticText,
} from "@/lib/support/inbox-poller";

let consoleWarnSpy: jest.SpyInstance;
let originalFetch: typeof fetch;

const baseTicket = {
  id: "tk-new",
  title: "Login broken",
  body: "AADSTS20012 — sign in failing",
  diagnostic_text: null,
  category: "general",
  severity: "p2",
  status: "open",
  audience: "client",
  created_by_user_id: "external:user@example.com",
  created_by_email: "user@example.com",
  draft_response: null,
  draft_generated_at: null,
  draft_pattern_ids: [],
  sent_response: null,
  sent_at: null,
  sent_to_email: null,
  helpful: null,
  edit_diff: null,
  feedback_notes: null,
  feedback_at: null,
  graph_message_id: "msg-1",
  graph_internet_message_id: "<msg-1@ex>",
  graph_conversation_id: "conv-1",
  created_at: "2026-04-27T01:00:00.000Z",
  updated_at: "2026-04-27T01:00:00.000Z",
};

function buildGraphMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-1",
    subject: "Login broken",
    bodyPreview: "AADSTS20012",
    from: { emailAddress: { address: "user@example.com", name: "Cust Omer" } },
    toRecipients: [{ emailAddress: { address: "support@thewolfpack.agency" } }],
    ccRecipients: [],
    body: { contentType: "text", content: "AADSTS20012 — sign in failing" },
    receivedDateTime: "2026-04-27T01:00:00.000Z",
    hasAttachments: false,
    internetMessageId: "<msg-1@ex>",
    conversationId: "conv-1",
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  originalFetch = global.fetch;
  /* Default cursor lookup → no cursor (first run). */
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("instinct_support_poll_state")) {
      return { rows: [] };
    }
    return { rows: [] };
  });
  mockWriteQuery.mockResolvedValue({ rows: [{ id: "support-inbox" }] });
  mockListPatterns.mockResolvedValue([]);
  mockFindMatching.mockReturnValue([]);
  mockGenerateDraft.mockResolvedValue({
    ok: true,
    draft: "Hi there, here is your draft.\nThe Wolfpack Team",
    pattern_ids: [],
    from_cache: false,
    tokens_used: 12,
  });
  mockFindByConv.mockResolvedValue(null);
  mockAppendReply.mockResolvedValue("reply-1");
  mockCreateTicket.mockResolvedValue({ ...baseTicket });
  mockUpdateTicket.mockResolvedValue({ ...baseTicket, status: "drafted" });
  delete process.env.SUPPORT_INBOX_MAILBOX_UPN;
});

afterEach(() => {
  consoleWarnSpy.mockRestore();
  global.fetch = originalFetch;
});

describe("getSupportMailboxBase", () => {
  it("returns /me when env var unset", () => {
    expect(getSupportMailboxBase()).toBe("/me");
  });

  it("returns /users/<encoded-upn> when env var set", () => {
    process.env.SUPPORT_INBOX_MAILBOX_UPN = "support@thewolfpack.agency";
    expect(getSupportMailboxBase()).toBe(
      "/users/support%40thewolfpack.agency",
    );
  });
});

describe("messageBodyToPlainText", () => {
  it("returns plain content unchanged when contentType=text", () => {
    const out = messageBodyToPlainText({
      id: "x",
      body: { contentType: "text", content: "Hello world" },
    });
    expect(out).toBe("Hello world");
  });

  it("strips HTML tags via cheerio when contentType=html", () => {
    const out = messageBodyToPlainText({
      id: "x",
      body: {
        contentType: "html",
        content: "<html><body><p>Hello <b>world</b></p><script>bad()</script></body></html>",
      },
    });
    expect(out).toContain("Hello");
    expect(out).toContain("world");
    expect(out).not.toContain("<p>");
    expect(out).not.toContain("bad()");
  });

  it("falls back to bodyPreview when no body content", () => {
    const out = messageBodyToPlainText({ id: "x", bodyPreview: "preview only" });
    expect(out).toBe("preview only");
  });
});

describe("extractDiagnosticText", () => {
  it("returns null on empty input", () => {
    expect(extractDiagnosticText("")).toBeNull();
  });

  it("extracts a tail block with AADSTS error code", () => {
    const out = extractDiagnosticText(
      "Hello team\n\nThe error is AADSTS20012 from this URL: https://login.live.com",
    );
    expect(out).toMatch(/AADSTS20012/);
  });

  it("returns null when the tail looks human", () => {
    expect(
      extractDiagnosticText("Hi team\n\nThanks for the help last week!"),
    ).toBeNull();
  });
});

describe("messageToTicket", () => {
  it("maps Graph fields to CreateTicketRow with audience=client + synthetic user id", () => {
    const out = messageToTicket(buildGraphMessage());
    expect(out.audience).toBe("client");
    expect(out.created_by_user_id).toBe("external:user@example.com");
    expect(out.created_by_email).toBe("user@example.com");
    expect(out.graph_message_id).toBe("msg-1");
    expect(out.graph_internet_message_id).toBe("<msg-1@ex>");
    expect(out.graph_conversation_id).toBe("conv-1");
    expect(out.title).toBe("Login broken");
  });

  it("falls back to '(no subject)' for empty subject", () => {
    const out = messageToTicket(buildGraphMessage({ subject: null }));
    expect(out.title).toBe("(no subject)");
  });
});

describe("pollSupportInbox", () => {
  it("returns skipped:'no_valid_token' and never calls fetch when getValidToken is null", async () => {
    mockGetValidToken.mockResolvedValueOnce(null);
    const fetchMock = jest.fn();
    global.fetch = fetchMock;

    const out = await pollSupportInbox({ userId: "u-1", userRole: "ops" });

    expect(out.skipped).toBe("no_valid_token");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockCreateTicket).not.toHaveBeenCalled();
    expect(mockWriteQuery).not.toHaveBeenCalled(); // cursor NOT advanced
  });

  it("returns counters=0 when Graph returns an empty value array", async () => {
    mockGetValidToken.mockResolvedValueOnce({
      accessToken: "tk",
      userEmail: "op@x.com",
    });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: [] }), { status: 200 }),
      ) as unknown as typeof fetch;

    const out = await pollSupportInbox({ userId: "u-1", userRole: "ops" });
    expect(out.messages_seen).toBe(0);
    expect(out.tickets_created).toBe(0);
    expect(out.errors).toBe(0);
  });

  it("creates two client tickets when 2 fresh messages arrive, persists draft, advances cursor", async () => {
    mockGetValidToken.mockResolvedValueOnce({
      accessToken: "tk",
      userEmail: "op@x.com",
    });
    const m1 = buildGraphMessage({
      id: "msg-1",
      conversationId: "conv-1",
      receivedDateTime: "2026-04-27T01:00:00.000Z",
    });
    const m2 = buildGraphMessage({
      id: "msg-2",
      conversationId: "conv-2",
      internetMessageId: "<msg-2@ex>",
      receivedDateTime: "2026-04-27T02:00:00.000Z",
    });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: [m1, m2] }), { status: 200 }),
      ) as unknown as typeof fetch;

    /* Both are fresh threads → conv lookup returns null both times. */
    mockFindByConv.mockResolvedValue(null);

    const out = await pollSupportInbox({ userId: "u-1", userRole: "ops" });

    expect(out.messages_seen).toBe(2);
    expect(out.tickets_created).toBe(2);
    expect(out.replies_appended).toBe(0);
    expect(out.drafts_generated).toBe(2);

    // Both tickets have audience='client'
    expect(mockCreateTicket).toHaveBeenCalledTimes(2);
    for (const call of mockCreateTicket.mock.calls) {
      expect(call[0].audience).toBe("client");
    }

    // Draft persisted via updateTicket
    expect(mockUpdateTicket).toHaveBeenCalled();
    const firstUpdate = mockUpdateTicket.mock.calls[0][1];
    expect(firstUpdate.draft_response).toContain("Wolfpack Team");
    expect(firstUpdate.status).toBe("drafted");

    // Cursor advanced to newest seen (msg-2's receivedDateTime)
    const cursorWrites = mockWriteQuery.mock.calls.filter((c) =>
      String(c[0]).includes("instinct_support_poll_state"),
    );
    expect(cursorWrites.length).toBeGreaterThan(0);
    expect(cursorWrites[0][1]).toEqual([
      "support-inbox",
      "2026-04-27T02:00:00.000Z",
    ]);
  });

  it("appends to existing ticket and does NOT create one when conversationId matches", async () => {
    mockGetValidToken.mockResolvedValueOnce({
      accessToken: "tk",
      userEmail: "op@x.com",
    });
    const reply = buildGraphMessage({
      id: "msg-reply",
      conversationId: "conv-existing",
      receivedDateTime: "2026-04-27T03:00:00.000Z",
    });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: [reply] }), { status: 200 }),
      ) as unknown as typeof fetch;

    mockFindByConv.mockResolvedValueOnce({
      ...baseTicket,
      id: "tk-existing",
      graph_conversation_id: "conv-existing",
    });

    const out = await pollSupportInbox({ userId: "u-1", userRole: "ops" });

    expect(out.replies_appended).toBe(1);
    expect(out.tickets_created).toBe(0);
    expect(mockCreateTicket).not.toHaveBeenCalled();
    expect(mockAppendReply).toHaveBeenCalledWith(
      "tk-existing",
      expect.objectContaining({
        graph_message_id: "msg-reply",
        direction: "inbound",
        from_email: "user@example.com",
      }),
    );
  });

  it("returns skipped:'no_valid_token' on Graph 401 and does NOT advance the cursor", async () => {
    mockGetValidToken.mockResolvedValueOnce({
      accessToken: "tk",
      userEmail: "op@x.com",
    });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
      ) as unknown as typeof fetch;

    const out = await pollSupportInbox({ userId: "u-1", userRole: "ops" });

    expect(out.skipped).toBe("no_valid_token");
    const cursorWrites = mockWriteQuery.mock.calls.filter((c) =>
      String(c[0]).includes("instinct_support_poll_state"),
    );
    expect(cursorWrites).toHaveLength(0);
  });

  it("returns errors=1 on Graph 500 and does NOT advance the cursor", async () => {
    mockGetValidToken.mockResolvedValueOnce({
      accessToken: "tk",
      userEmail: "op@x.com",
    });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(new Response("upstream broke", { status: 500 })) as unknown as typeof fetch;

    const out = await pollSupportInbox({ userId: "u-1", userRole: "ops" });

    expect(out.errors).toBe(1);
    expect(out.tickets_created).toBe(0);
    const cursorWrites = mockWriteQuery.mock.calls.filter((c) =>
      String(c[0]).includes("instinct_support_poll_state"),
    );
    expect(cursorWrites).toHaveLength(0);
  });

  it("skips messages older than the existing cursor", async () => {
    /* Cursor is in the past; one message is older, one is newer. */
    mockQuery.mockReset();
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("instinct_support_poll_state")) {
        return {
          rows: [{ last_received_at: "2026-04-27T01:30:00.000Z" }],
        };
      }
      return { rows: [] };
    });
    mockGetValidToken.mockResolvedValueOnce({
      accessToken: "tk",
      userEmail: "op@x.com",
    });
    const old = buildGraphMessage({
      id: "msg-old",
      conversationId: "conv-old",
      receivedDateTime: "2026-04-27T01:00:00.000Z",
    });
    const fresh = buildGraphMessage({
      id: "msg-fresh",
      conversationId: "conv-fresh",
      receivedDateTime: "2026-04-27T02:00:00.000Z",
    });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: [old, fresh] }), { status: 200 }),
      ) as unknown as typeof fetch;

    const out = await pollSupportInbox({ userId: "u-1", userRole: "ops" });

    expect(out.messages_seen).toBe(2);
    expect(out.tickets_created).toBe(1); // only the fresh one
    expect(mockCreateTicket).toHaveBeenCalledTimes(1);
  });

  it("uses /users/<upn> path when SUPPORT_INBOX_MAILBOX_UPN is set", async () => {
    process.env.SUPPORT_INBOX_MAILBOX_UPN = "support@thewolfpack.agency";
    mockGetValidToken.mockResolvedValueOnce({
      accessToken: "tk",
      userEmail: "op@x.com",
    });
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: [] }), { status: 200 }),
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    await pollSupportInbox({ userId: "u-1", userRole: "ops" });

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/users/support%40thewolfpack.agency");
    expect(calledUrl).toContain("/mailFolders/inbox/messages");
    /* Sanity: Graph requires ConsistencyLevel: eventual on shared
       mailboxes when $orderby is in play. */
    const headers = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers.ConsistencyLevel).toBe("eventual");
  });

  it("does not throw when generateDraftResponse fails — ticket still created", async () => {
    mockGetValidToken.mockResolvedValueOnce({
      accessToken: "tk",
      userEmail: "op@x.com",
    });
    mockGenerateDraft.mockResolvedValueOnce({
      ok: false,
      error_detail: "ANTHROPIC_API_KEY not set",
      pattern_ids: [],
    });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: [buildGraphMessage()] }), {
          status: 200,
        }),
      ) as unknown as typeof fetch;

    const out = await pollSupportInbox({ userId: "u-1", userRole: "ops" });

    expect(out.tickets_created).toBe(1);
    expect(out.drafts_generated).toBe(0);
    expect(mockCreateTicket).toHaveBeenCalled();
  });
});
