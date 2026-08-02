/**
 * Microsoft Mail inbox-actions tests.
 *
 * Covers: listInbox happy path + filters, setMessageReadState PATCH wiring,
 * archiveMessage move-to-Archive, deleteMessage soft-delete, replyAll +
 * forward Graph endpoints.
 */
 

const mockTrackInbox = jest.fn();
const mockQueryInbox = jest.fn();
const mockGetValidTokenInbox = jest.fn();
const mockRecordAuditInbox = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrackInbox(...args),
}));

jest.mock("@/lib/db", () => ({
  query: (...args: any[]) => mockQueryInbox(...args),
  safeQuery: jest.fn(),
  pool: { query: jest.fn() },
  // activePool() replaced direct pool use so every query is routed to the
  // tenant's database. The mock must expose it or the module under test
  // calls undefined.
  activePool: () => ({ query: jest.fn() }),
}));

jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...args: any[]) => mockGetValidTokenInbox(...args),
}));

jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...args: any[]) => mockRecordAuditInbox(...args),
}));

const realFetchInbox = global.fetch;
const fetchMockInbox = jest.fn();

beforeAll(() => {
  (global as any).fetch = fetchMockInbox;
});
afterAll(() => {
  (global as any).fetch = realFetchInbox;
});

beforeEach(() => {
  jest.clearAllMocks();
  fetchMockInbox.mockReset();
  mockGetValidTokenInbox.mockResolvedValue({ accessToken: "tok-abc" });
  mockQueryInbox.mockResolvedValue({ rows: [] });
  mockRecordAuditInbox.mockResolvedValue({ id: "a", seq: 1, entryHash: "h" });
});

function okJson(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as any;
}

function err(status: number, body: any = {}) {
  return {
    ok: false,
    status,
    headers: new Headers(),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as any;
}

import {
  listInbox,
  setMessageReadState,
  archiveMessage,
  deleteMessage,
  replyAllToMessage,
  forwardMessage,
} from "@/lib/integrations/microsoft-mail";

describe("listInbox", () => {
  it("returns normalized messages on happy path", async () => {
    fetchMockInbox.mockResolvedValueOnce(
      okJson({
        value: [
          {
            id: "m1",
            subject: "Hello",
            from: { emailAddress: { name: "Jane", address: "jane@x.co" } },
            receivedDateTime: "2026-04-22T10:00:00Z",
            bodyPreview: "Hi",
            isRead: false,
            hasAttachments: true,
            importance: "high",
            webLink: "https://outlook.office.com/m/m1",
          },
        ],
        "@odata.count": 1,
      }),
    );
    const r = await listInbox("u1", { unreadOnly: true, top: 10 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.messages).toHaveLength(1);
    expect(r.value.messages[0]).toEqual({
      id: "m1",
      subject: "Hello",
      from: { name: "Jane", email: "jane@x.co" },
      receivedDateTime: "2026-04-22T10:00:00Z",
      bodyPreview: "Hi",
      isRead: false,
      hasAttachments: true,
      importance: "high",
      webLink: "https://outlook.office.com/m/m1",
      // isDraft is now part of the normalized row (defaults to false
      // when Graph doesn't return the field).
      isDraft: false,
    });
    expect(r.value.unreadCount).toBe(1);
    // Asserts the URL includes the unread filter + select
    const calledUrl = fetchMockInbox.mock.calls[0][0];
    expect(calledUrl).toContain("$top=10");
    expect(calledUrl).toContain("isRead%20eq%20false");
  });

  it("returns scope_missing on 403", async () => {
    fetchMockInbox.mockResolvedValueOnce(err(403, { error: { code: "AccessDenied", message: "no scope" } }));
    const r = await listInbox("u1");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("scope_missing");
  });

  it("not_connected when no token", async () => {
    mockGetValidTokenInbox.mockResolvedValueOnce(null);
    const r = await listInbox("u1");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("not_connected");
  });
});

describe("setMessageReadState", () => {
  it("PATCH /me/messages/{id} with isRead", async () => {
    fetchMockInbox.mockResolvedValueOnce(okJson({}, 200));
    const r = await setMessageReadState("u1", "msg-x", false);
    expect(r.ok).toBe(true);
    const [url, init] = fetchMockInbox.mock.calls[0];
    expect(url).toContain("/me/messages/msg-x");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ isRead: false });
  });

  it("invalid_input on empty id", async () => {
    const r = await setMessageReadState("u1", "  ", true);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_input");
    expect(fetchMockInbox).not.toHaveBeenCalled();
  });
});

describe("archiveMessage", () => {
  it("POSTs /move with destinationId archive and returns new id", async () => {
    fetchMockInbox.mockResolvedValueOnce(okJson({ id: "new-id" }, 201));
    const r = await archiveMessage("u1", "src-id");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.id).toBe("new-id");
    const [url, init] = fetchMockInbox.mock.calls[0];
    expect(url).toContain("/me/messages/src-id/move");
    expect(JSON.parse(init.body)).toEqual({ destinationId: "archive" });
  });
});

describe("deleteMessage", () => {
  it("DELETEs /me/messages/{id}", async () => {
    fetchMockInbox.mockResolvedValueOnce(okJson(null, 204));
    const r = await deleteMessage("u1", "msg-x");
    expect(r.ok).toBe(true);
    const [url, init] = fetchMockInbox.mock.calls[0];
    expect(url).toContain("/me/messages/msg-x");
    expect(init.method).toBe("DELETE");
  });

  it("returns not_found for graph 404", async () => {
    fetchMockInbox.mockResolvedValueOnce(err(404, { error: { message: "missing" } }));
    const r = await deleteMessage("u1", "msg-x");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("graph_error");
    expect(r.status).toBe(404);
  });
});

describe("replyAllToMessage", () => {
  it("POSTs /replyAll with comment for text-only", async () => {
    fetchMockInbox.mockResolvedValueOnce(okJson({}, 202));
    const r = await replyAllToMessage("u1", "src", { bodyText: "thanks" });
    expect(r.ok).toBe(true);
    const [url, init] = fetchMockInbox.mock.calls[0];
    expect(url).toContain("/me/messages/src/replyAll");
    expect(JSON.parse(init.body)).toEqual({ comment: "thanks" });
  });

  it("invalid_input when no body", async () => {
    const r = await replyAllToMessage("u1", "src", {});
    expect(r.ok).toBe(false);
  });
});

describe("forwardMessage", () => {
  it("POSTs /forward with toRecipients normalized", async () => {
    fetchMockInbox.mockResolvedValueOnce(okJson({}, 202));
    const r = await forwardMessage(
      "u1",
      "src",
      ["a@x.co", " b@x.co "],
      { bodyText: "fyi" },
    );
    expect(r.ok).toBe(true);
    const [url, init] = fetchMockInbox.mock.calls[0];
    expect(url).toContain("/me/messages/src/forward");
    const body = JSON.parse(init.body);
    expect(body.toRecipients).toEqual([
      { emailAddress: { address: "a@x.co" } },
      { emailAddress: { address: "b@x.co" } },
    ]);
    expect(body.comment).toBe("fyi");
  });

  it("invalid_input when toRecipients empty", async () => {
    const r = await forwardMessage("u1", "src", [], { bodyText: "fyi" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_input");
  });
});
