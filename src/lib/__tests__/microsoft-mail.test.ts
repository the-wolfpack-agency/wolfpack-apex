/**
 * Microsoft Mail integration tests.
 *
 * Covers: sendMail happy path (Graph + cache + audit + analytics),
 * replyToMessage (in_reply_to propagates), 403 → scope_missing return,
 * 429 with Retry-After honored, body_preview truncation to 512 chars.
 */
 

const mockTrackMail = jest.fn();
const mockQueryMail = jest.fn();
const mockGetValidTokenMail = jest.fn();
const mockRecordAuditMail = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrackMail(...args),
}));

jest.mock("@/lib/db", () => ({
  query: (...args: any[]) => mockQueryMail(...args),
  safeQuery: jest.fn(),
  pool: { query: jest.fn() },
}));

jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...args: any[]) => mockGetValidTokenMail(...args),
}));

jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...args: any[]) => mockRecordAuditMail(...args),
}));

const realFetchMail = global.fetch;
const fetchMockMail = jest.fn();

beforeAll(() => {
  (global as any).fetch = fetchMockMail;
  process.env.DATABASE_URL = "postgres://test";
});
afterAll(() => {
  (global as any).fetch = realFetchMail;
});

beforeEach(() => {
  jest.clearAllMocks();
  fetchMockMail.mockReset();
  mockGetValidTokenMail.mockResolvedValue({ accessToken: "tok-abc", userEmail: "u@example.com" });
  mockQueryMail.mockResolvedValue({ rows: [] });
  mockRecordAuditMail.mockResolvedValue({ id: "audit-1", seq: 1, entryHash: "h" });
});

function okJsonResMail(body: unknown, extraHeaders: Record<string, string> = {}) {
  const headers = new Headers({ ...extraHeaders });
  return {
    ok: true,
    status: 200,
    headers,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as any;
}
function acceptedResMail(headers: Record<string, string> = {}) {
  return {
    ok: true,
    status: 202,
    headers: new Headers(headers),
    json: () => Promise.resolve(null),
    text: () => Promise.resolve(""),
  } as any;
}
function errResMail(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: false,
    status,
    headers: {
      get: (k: string) => headers[k.toLowerCase()] ?? headers[k] ?? null,
    },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  } as any;
}

// ---------------------------------------------------------------------------
// sendMail - happy path
// ---------------------------------------------------------------------------

describe("sendMail", () => {
  it("posts to /me/sendMail with recipients + writes cache + audit + analytics", async () => {
    fetchMockMail.mockResolvedValueOnce(acceptedResMail({ "x-ms-message-id": "msg-123" }));
    const { sendMail } = await import("@/lib/integrations/microsoft-mail");

    const result = await sendMail("user-1", {
      to: ["a@example.com", "b@example.com"],
      subject: "Hello",
      bodyText: "World",
    }, "cto");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.id).toBe("msg-123");
    expect(result.value.savedToSent).toBe(true);

    expect(fetchMockMail).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMockMail.mock.calls[0];
    expect(url).toBe("https://graph.microsoft.com/v1.0/me/sendMail");
    expect(init.method).toBe("POST");
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.saveToSentItems).toBe(true);
    expect(sentBody.message.toRecipients).toHaveLength(2);
    expect(sentBody.message.toRecipients[0].emailAddress.address).toBe("a@example.com");

    expect(mockQueryMail).toHaveBeenCalledTimes(1);
    const insertArgs = mockQueryMail.mock.calls[0][1];
    expect(insertArgs[0]).toBe("user-1");
    expect(insertArgs[1]).toBe("msg-123");
    expect(JSON.parse(insertArgs[2])).toEqual(["a@example.com", "b@example.com"]);

    expect(mockRecordAuditMail).toHaveBeenCalledTimes(1);
    const auditArg = mockRecordAuditMail.mock.calls[0][0];
    expect(auditArg.action).toBe("mail.sent");
    expect(auditArg.resourceType).toBe("mail");
    expect(auditArg.resourceId).toBe("msg-123");
    expect(auditArg.afterState).toMatchObject({ subject: "Hello", to: ["a@example.com", "b@example.com"] });
    expect(auditArg.afterState.body).toBeUndefined();
    expect(auditArg.afterState.bodyHtml).toBeUndefined();

    const events = mockTrackMail.mock.calls.map((c) => c[0]);
    expect(events).toContain("system.ms_mail_sent");
  });

  it("supports HTML body and saveToSentItems:false", async () => {
    fetchMockMail.mockResolvedValueOnce(okJsonResMail({ id: "msg-html" }));
    const { sendMail } = await import("@/lib/integrations/microsoft-mail");
    const result = await sendMail("user-1", {
      to: ["a@example.com"],
      subject: "HTML test",
      bodyHtml: "<p>Hi</p>",
      saveToSentItems: false,
    });
    expect(result.ok).toBe(true);
    const sentBody = JSON.parse(fetchMockMail.mock.calls[0][1].body);
    expect(sentBody.saveToSentItems).toBe(false);
    expect(sentBody.message.body.contentType).toBe("HTML");
    expect(sentBody.message.body.content).toBe("<p>Hi</p>");
  });

  it("returns invalid_input when `to` is empty", async () => {
    const { sendMail } = await import("@/lib/integrations/microsoft-mail");
    const result = await sendMail("u", { to: [], subject: "x", bodyText: "y" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected err");
    expect(result.code).toBe("invalid_input");
    expect(fetchMockMail).not.toHaveBeenCalled();
  });

  it("returns invalid_input when subject is missing", async () => {
    const { sendMail } = await import("@/lib/integrations/microsoft-mail");
    const result = await sendMail("u", { to: ["a@b.com"], subject: "", bodyText: "y" });
    if (result.ok) throw new Error("expected err");
    expect(result.code).toBe("invalid_input");
  });

  it("returns invalid_input when no body", async () => {
    const { sendMail } = await import("@/lib/integrations/microsoft-mail");
    const result = await sendMail("u", { to: ["a@b.com"], subject: "hi" });
    if (result.ok) throw new Error("expected err");
    expect(result.code).toBe("invalid_input");
  });

  it("returns not_connected when getValidToken returns null", async () => {
    mockGetValidTokenMail.mockResolvedValueOnce(null);
    const { sendMail } = await import("@/lib/integrations/microsoft-mail");
    const result = await sendMail("u", { to: ["a@b.com"], subject: "hi", bodyText: "y" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected err");
    expect(result.code).toBe("not_connected");
    expect(fetchMockMail).not.toHaveBeenCalled();
    expect(mockTrackMail).toHaveBeenCalledWith("system.ms_mail_send_failed", "u", expect.any(String), expect.objectContaining({ reason: "not_connected" }));
  });

  it("returns scope_missing on 403 with AccessDenied", async () => {
    fetchMockMail.mockResolvedValueOnce({
      ok: false,
      status: 403,
      headers: { get: () => null },
      json: () => Promise.resolve({ error: { code: "ErrorAccessDeniedMissingScope", message: "Missing Mail.Send" } }),
      text: () => Promise.resolve(""),
    } as any);
    const { sendMail } = await import("@/lib/integrations/microsoft-mail");
    const result = await sendMail("u", { to: ["a@b.com"], subject: "hi", bodyText: "y" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected err");
    expect(result.code).toBe("scope_missing");
    expect(result.scope).toBe("Mail.Send");
    expect(mockQueryMail).not.toHaveBeenCalled();
    expect(mockRecordAuditMail).not.toHaveBeenCalled();
    expect(mockTrackMail).toHaveBeenCalledWith(
      "system.ms_mail_send_failed",
      "u",
      expect.any(String),
      expect.objectContaining({ reason: "scope_missing", scope: "Mail.Send" }),
    );
  });

  it("honors Retry-After on 429 and retries once", async () => {
    fetchMockMail
      .mockResolvedValueOnce(errResMail(429, { error: { code: "throttled" } }, { "retry-after": "0" }))
      .mockResolvedValueOnce(acceptedResMail({ "x-ms-message-id": "msg-after-retry" }));
    const { sendMail } = await import("@/lib/integrations/microsoft-mail");
    const result = await sendMail("u", { to: ["a@b.com"], subject: "hi", bodyText: "y" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.id).toBe("msg-after-retry");
    expect(fetchMockMail).toHaveBeenCalledTimes(2);
  });

  it("returns rate_limited when 429 persists after retry", async () => {
    fetchMockMail
      .mockResolvedValueOnce(errResMail(429, { error: { code: "throttled" } }, { "retry-after": "0" }))
      .mockResolvedValueOnce(errResMail(429, { error: { code: "throttled" } }, { "retry-after": "0" }));
    const { sendMail } = await import("@/lib/integrations/microsoft-mail");
    const result = await sendMail("u", { to: ["a@b.com"], subject: "hi", bodyText: "y" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected err");
    expect(result.code).toBe("rate_limited");
  });

  it("truncates body_preview to 512 characters", async () => {
    fetchMockMail.mockResolvedValueOnce(okJsonResMail({ id: "msg-long" }));
    const { sendMail, __internal } = await import("@/lib/integrations/microsoft-mail");
    expect(__internal.BODY_PREVIEW_MAX).toBe(512);

    const longBody = "x".repeat(1000);
    await sendMail("u", { to: ["a@b.com"], subject: "long", bodyText: longBody });
    const preview = mockQueryMail.mock.calls[0][1][6]; // body_preview column
    expect(typeof preview).toBe("string");
    expect(preview.length).toBe(512);
  });

  it("truncateBodyPreview strips HTML tags", async () => {
    const { __internal } = await import("@/lib/integrations/microsoft-mail");
    const preview = __internal.truncateBodyPreview({ bodyHtml: "<p>Hello <b>world</b></p>" });
    expect(preview).toBe("Hello world");
  });
});

// ---------------------------------------------------------------------------
// replyToMessage
// ---------------------------------------------------------------------------

describe("replyToMessage", () => {
  it("posts to /me/messages/{id}/reply and propagates in_reply_to", async () => {
    fetchMockMail.mockResolvedValueOnce(acceptedResMail({ "x-ms-message-id": "reply-1" }));
    const { replyToMessage } = await import("@/lib/integrations/microsoft-mail");

    const result = await replyToMessage("user-1", "original-abc", { bodyText: "thanks" }, "cto");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    const url = fetchMockMail.mock.calls[0][0] as string;
    expect(url).toBe("https://graph.microsoft.com/v1.0/me/messages/original-abc/reply");

    const insertArgs = mockQueryMail.mock.calls[0][1];
    expect(insertArgs[7]).toBe("original-abc");

    const events = mockTrackMail.mock.calls.map((c) => c[0]);
    expect(events).toContain("system.ms_mail_reply_sent");

    expect(mockRecordAuditMail.mock.calls[0][0].action).toBe("mail.replied");
  });

  it("returns invalid_input when body is missing", async () => {
    const { replyToMessage } = await import("@/lib/integrations/microsoft-mail");
    const result = await replyToMessage("u", "orig", {} as any);
    if (result.ok) throw new Error("expected err");
    expect(result.code).toBe("invalid_input");
  });

  it("returns scope_missing on 403", async () => {
    fetchMockMail.mockResolvedValueOnce({
      ok: false,
      status: 403,
      headers: { get: () => null },
      json: () => Promise.resolve({ error: { code: "Authorization_RequestDenied", message: "forbidden" } }),
      text: () => Promise.resolve(""),
    } as any);
    const { replyToMessage } = await import("@/lib/integrations/microsoft-mail");
    const result = await replyToMessage("u", "o", { bodyText: "hi" });
    if (result.ok) throw new Error("expected err");
    expect(result.code).toBe("scope_missing");
  });
});

// ---------------------------------------------------------------------------
// searchMessages - Graph /search/query wrapper used by the assistant
// context resolver.
// ---------------------------------------------------------------------------

describe("searchMessages", () => {
  it("posts to /search/query with entityTypes=['message'] and maps hits", async () => {
    fetchMockMail.mockResolvedValueOnce(okJsonResMail({
      value: [{
        hitsContainers: [{
          total: 2,
          hits: [
            {
              hitId: "h1",
              summary: "<b>Porsche</b> dealer pipeline status",
              resource: {
                id: "msg-1",
                subject: "Porsche pipeline",
                bodyPreview: "Update on the Porsche dealer pipeline",
                from: { emailAddress: { name: "Aidan", address: "aidan@example.com" } },
                receivedDateTime: "2026-03-12T15:00:00Z",
                webLink: "https://outlook.office.com/m/msg-1",
              },
            },
            {
              hitId: "h2",
              summary: "Ad-hoc Q2 review",
              resource: {
                id: "msg-2",
                subject: "Q2 review",
                bodyPreview: "Final review",
                from: { emailAddress: { address: "ops@example.com" } },
                receivedDateTime: "2026-03-15T09:00:00Z",
              },
            },
          ],
        }],
      }],
    }));

    const { searchMessages } = await import("@/lib/integrations/microsoft-mail");
    const r = await searchMessages("user-1", { query: "porsche dealer" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.value.hits).toHaveLength(2);
    expect(r.value.total).toBe(2);

    const first = r.value.hits[0];
    expect(first.id).toBe("msg-1");
    expect(first.from).toBe("Aidan");
    expect(first.subject).toBe("Porsche pipeline");
    expect(first.received_at).toBe("2026-03-12T15:00:00Z");
    expect(first.snippet).not.toContain("<b>");
    expect(first.snippet).toContain("Porsche");
    expect(first.url).toBe("https://outlook.office.com/m/msg-1");
    expect(first.source_kind).toBe("email");

    /* Falls back to the address when no name. */
    expect(r.value.hits[1].from).toBe("ops@example.com");
    expect(r.value.hits[1].url).toBeUndefined();

    const url = fetchMockMail.mock.calls[0][0] as string;
    expect(url).toBe("https://graph.microsoft.com/v1.0/search/query");
    const init = fetchMockMail.mock.calls[0][1];
    const body = JSON.parse(init.body as string);
    expect(body.requests[0].entityTypes).toEqual(["message"]);
    /* The keyword extractor lowercases plain nouns and drops nothing in a
       short noun-only query, so "porsche dealer" passes through unchanged. */
    expect(body.requests[0].query.queryString).toBe("porsche dealer");
  });

  it("respects topN cap (default 5)", async () => {
    /* Graph already obeys size in our request body, but the helper also
       slices defensively if Graph returns more. Verify the request size.  */
    fetchMockMail.mockResolvedValueOnce(okJsonResMail({
      value: [{ hitsContainers: [{ total: 0, hits: [] }] }],
    }));
    const { searchMessages } = await import("@/lib/integrations/microsoft-mail");
    await searchMessages("u", { query: "anything", topN: 7 });
    const init = fetchMockMail.mock.calls[0][1];
    const body = JSON.parse(init.body as string);
    expect(body.requests[0].size).toBe(7);
  });

  it("returns scope_missing on 403 and never throws", async () => {
    fetchMockMail.mockResolvedValueOnce(errResMail(403, {
      error: { code: "ErrorAccessDenied", message: "scope missing" },
    }));
    const { searchMessages } = await import("@/lib/integrations/microsoft-mail");
    const r = await searchMessages("u", { query: "x" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("scope_missing");
    expect(r.scope).toBe("Mail.Read");
    expect(r.status).toBe(403);
  });

  it("returns graph_error on unexpected 500", async () => {
    fetchMockMail.mockResolvedValueOnce(errResMail(500, "boom"));
    const { searchMessages } = await import("@/lib/integrations/microsoft-mail");
    const r = await searchMessages("u", { query: "x" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("graph_error");
  });

  it("returns invalid_input when query is empty", async () => {
    const { searchMessages } = await import("@/lib/integrations/microsoft-mail");
    const r = await searchMessages("u", { query: "  " });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_input");
    expect(fetchMockMail).not.toHaveBeenCalled();
  });

  it("returns not_connected when token is missing", async () => {
    mockGetValidTokenMail.mockResolvedValueOnce(null);
    const { searchMessages } = await import("@/lib/integrations/microsoft-mail");
    const r = await searchMessages("u", { query: "x" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("not_connected");
  });

  it("trackEmailLookupFailure emits assistant.email_lookup_failed", async () => {
    const { trackEmailLookupFailure } = await import("@/lib/integrations/microsoft-mail");
    trackEmailLookupFailure("u", "cto", { ok: false, code: "scope_missing", status: 403 });
    expect(mockTrackMail).toHaveBeenCalledWith(
      "assistant.email_lookup_failed",
      "u",
      "cto",
      expect.objectContaining({ status: 403, scope_missing: true, code: "scope_missing" }),
    );
  });
});

// ---------------------------------------------------------------------------
// createDraft - POST /me/messages, 
// ---------------------------------------------------------------------------
describe("createDraft", () => {
  it("posts to /me/messages and returns the draft id + webLink (no send)", async () => {
    fetchMockMail.mockResolvedValueOnce(
      okJsonResMail({ id: "draft-7", webLink: "https://outlook/draft-7" }, { "x-ms-message-id": "draft-7" }),
    );
    const { createDraft } = await import("@/lib/integrations/microsoft-mail");
    const result = await createDraft(
      "user-1",
      { to: ["dana@acme.com"], subject: "Overdue invoice", bodyText: "Please remit INV-204." },
      "ceo",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.id).toBe("draft-7");
    expect(result.value.webLink).toBe("https://outlook/draft-7");

    expect(fetchMockMail).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMockMail.mock.calls[0];
    expect(url).toBe("https://graph.microsoft.com/v1.0/me/messages");
    expect(init.method).toBe("POST");
    const sent = JSON.parse(init.body);
    expect(sent.toRecipients).toEqual([{ emailAddress: { address: "dana@acme.com" } }]);
    expect(sent.subject).toBe("Overdue invoice");
    // Audited as a draft + analytics fired.
    expect(mockRecordAuditMail).toHaveBeenCalled();
    expect(mockTrackMail).toHaveBeenCalledWith(
      "mail.draft_created",
      "user-1",
      "ceo",
      expect.objectContaining({ to_count: 1 }),
    );
  });

  it("returns scope_missing on 403 (Mail.ReadWrite) and does not audit", async () => {
    fetchMockMail.mockResolvedValueOnce({
      ok: false,
      status: 403,
      headers: { get: () => null },
      json: () => Promise.resolve({ error: { code: "ErrorAccessDeniedMissingScope", message: "Missing Mail.ReadWrite" } }),
      text: () => Promise.resolve(""),
    } as any);
    const { createDraft } = await import("@/lib/integrations/microsoft-mail");
    const result = await createDraft("u", { to: ["a@b.com"], subject: "hi", bodyText: "y" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected err");
    expect(result.code).toBe("scope_missing");
    expect(result.scope).toBe("Mail.ReadWrite");
    expect(mockRecordAuditMail).not.toHaveBeenCalled();
  });

  it("rejects a missing recipient before calling Graph", async () => {
    const { createDraft } = await import("@/lib/integrations/microsoft-mail");
    const result = await createDraft("u", { to: [], subject: "hi", bodyText: "y" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected err");
    expect(result.code).toBe("invalid_input");
    expect(fetchMockMail).not.toHaveBeenCalled();
  });
});
