/**
 * API: GET /api/microsoft/messages/unread-count.
 *
 * Covers:
 *   - 401 without auth
 *   - connected:false when no MS token
 *   - scope_missing when Graph returns 403
 *   - 5xx from Graph degrades to count:0 (NEVER throws)
 *   - happy-path returns @odata.count
 *   - first poll (no ?since=) does NOT trigger notify() fan-out
 *   - ?since= triggers notify() once per fresh inbox message,
 *     deduped by Graph message id, capped at 5
 *   - analytics event microsoft.email_unread_polled fires on every
 *     resolved path
 *   - last-resort try/catch returns 200 + count:0 even if a downstream
 *     dep throws unexpectedly
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export {};

const mockGetUser = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: any[]) => mockGetUser(...a),
}));

const mockGetValidToken = jest.fn();
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...a: any[]) => mockGetValidToken(...a),
}));

const mockNotify = jest.fn();
jest.mock("@/lib/notifications/in-app", () => ({
  notify: (...a: any[]) => mockNotify(...a),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));

function mkReq(path: string, auth?: string): any {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return new Request(`http://test${path}`, { method: "GET", headers }) as any;
}

function mkGraphRes(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const USER = { id: "u1", email: "a@x.com", role: "dev" };

beforeEach(() => {
  jest.clearAllMocks();
  // Default fetch stub — overridden per-test.
  (global as any).fetch = jest.fn();
  mockNotify.mockResolvedValue({ id: "n1" });
});

describe("GET /api/microsoft/messages/unread-count", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const { GET } = await import(
      "@/app/api/microsoft/messages/unread-count/route"
    );
    const res = await GET(mkReq("/api/microsoft/messages/unread-count"));
    expect(res.status).toBe(401);
  });

  it("200 { count:0, connected:false } when no MS token + fires analytics", async () => {
    mockGetUser.mockReturnValue(USER);
    mockGetValidToken.mockResolvedValue(null);

    const { GET } = await import(
      "@/app/api/microsoft/messages/unread-count/route"
    );
    const res = await GET(
      mkReq("/api/microsoft/messages/unread-count", "Bearer t"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ count: 0, connected: false });

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "microsoft.email_unread_polled",
      "u1",
      "dev",
      expect.objectContaining({ count: 0, connected: false }),
    );
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("200 { count:0, scope_missing:true } when Graph returns 403", async () => {
    mockGetUser.mockReturnValue(USER);
    mockGetValidToken.mockResolvedValue({
      accessToken: "T",
      userEmail: "a@x.com",
    });
    (global as any).fetch.mockResolvedValue(mkGraphRes({}, false, 403));

    const { GET } = await import(
      "@/app/api/microsoft/messages/unread-count/route"
    );
    const res = await GET(
      mkReq("/api/microsoft/messages/unread-count", "Bearer t"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ count: 0, scope_missing: true });

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "microsoft.email_unread_polled",
      "u1",
      "dev",
      expect.objectContaining({ count: 0, scope_missing: true }),
    );
  });

  it("Graph 5xx degrades to count:0 (NEVER throws)", async () => {
    mockGetUser.mockReturnValue(USER);
    mockGetValidToken.mockResolvedValue({
      accessToken: "T",
      userEmail: "a@x.com",
    });
    (global as any).fetch.mockResolvedValue(mkGraphRes({}, false, 503));

    const { GET } = await import(
      "@/app/api/microsoft/messages/unread-count/route"
    );
    const res = await GET(
      mkReq("/api/microsoft/messages/unread-count", "Bearer t"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ count: 0 });
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "microsoft.email_unread_polled",
      "u1",
      "dev",
      expect.objectContaining({ count: 0, graph_status: 503 }),
    );
  });

  it("Graph network error degrades to count:0", async () => {
    mockGetUser.mockReturnValue(USER);
    mockGetValidToken.mockResolvedValue({
      accessToken: "T",
      userEmail: "a@x.com",
    });
    (global as any).fetch.mockRejectedValue(new Error("ECONNRESET"));
    const err = jest.spyOn(console, "error").mockImplementation(() => {});

    const { GET } = await import(
      "@/app/api/microsoft/messages/unread-count/route"
    );
    const res = await GET(
      mkReq("/api/microsoft/messages/unread-count", "Bearer t"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ count: 0 });
    err.mockRestore();
  });

  it("happy path returns @odata.count and does NOT notify on first poll", async () => {
    mockGetUser.mockReturnValue(USER);
    mockGetValidToken.mockResolvedValue({
      accessToken: "T",
      userEmail: "a@x.com",
    });
    (global as any).fetch.mockResolvedValue(
      mkGraphRes({
        "@odata.count": 7,
        value: [
          {
            id: "msg1",
            subject: "Hello",
            bodyPreview: "Hi there",
            receivedDateTime: "2030-01-01T00:00:00Z",
            isRead: false,
            from: {
              emailAddress: { name: "Alice", address: "alice@example.com" },
            },
          },
        ],
      }),
    );

    const { GET } = await import(
      "@/app/api/microsoft/messages/unread-count/route"
    );
    const res = await GET(
      mkReq("/api/microsoft/messages/unread-count", "Bearer t"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(7);
    expect(body.since).toBeNull();
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "microsoft.email_unread_polled",
      "u1",
      "dev",
      expect.objectContaining({ count: 7, has_since: false }),
    );
  });

  it("?since= fans out notify() for messages newer than since, capped at 5", async () => {
    mockGetUser.mockReturnValue(USER);
    mockGetValidToken.mockResolvedValue({
      accessToken: "T",
      userEmail: "a@x.com",
    });

    // 6 messages, 4 fresh + 2 stale. Cap is 5 — but only 4 are fresh,
    // so we expect exactly 4 notify() calls.
    const messages = [
      {
        id: "fresh1",
        subject: "First",
        bodyPreview: "",
        receivedDateTime: "2026-04-30T12:00:00Z",
        isRead: false,
        from: {
          emailAddress: { name: "Bob", address: "bob@example.com" },
        },
      },
      {
        id: "fresh2",
        subject: "",
        bodyPreview: "",
        receivedDateTime: "2026-04-30T11:00:00Z",
        isRead: false,
        from: {
          emailAddress: { name: "", address: "carol@example.com" },
        },
      },
      {
        id: "fresh3",
        subject: "Third",
        bodyPreview: "",
        receivedDateTime: "2026-04-30T10:00:00Z",
        isRead: false,
        from: null,
      },
      {
        id: "fresh4",
        subject: "Fourth",
        bodyPreview: "",
        receivedDateTime: "2026-04-30T09:00:00Z",
        isRead: false,
        from: {
          emailAddress: { name: "Dan", address: "dan@example.com" },
        },
      },
      {
        id: "stale1",
        subject: "old",
        bodyPreview: "",
        receivedDateTime: "2026-04-28T00:00:00Z",
        isRead: false,
        from: {
          emailAddress: { name: "Eve", address: "eve@example.com" },
        },
      },
      {
        id: "weird",
        subject: "no-date",
        bodyPreview: "",
        receivedDateTime: "not-a-date",
        isRead: false,
        from: {
          emailAddress: { name: "Frank", address: "frank@example.com" },
        },
      },
    ];

    (global as any).fetch.mockResolvedValue(
      mkGraphRes({ "@odata.count": 6, value: messages }),
    );

    const since = "2026-04-29T00:00:00Z";
    const { GET } = await import(
      "@/app/api/microsoft/messages/unread-count/route"
    );
    const res = await GET(
      mkReq(
        `/api/microsoft/messages/unread-count?since=${encodeURIComponent(since)}`,
        "Bearer t",
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(6);
    expect(body.since).toBe(new Date(since).toISOString());

    // Exactly 4 fresh-and-valid messages → exactly 4 notify() calls.
    expect(mockNotify).toHaveBeenCalledTimes(4);

    // Each call has the expected shape — kind in metadata, dedup on, etc.
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        category: "email_arrived",
        source: "microsoft.email",
        sourceId: "fresh1",
        title: "New email from Bob",
        body: "First",
        actionUrl: "/emails/fresh1",
        dedup: true,
        metadata: expect.objectContaining({
          kind: "email_arrived",
          message_id: "fresh1",
          sender: "Bob",
        }),
      }),
    );

    // Empty subject falls back to "(no subject)".
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "fresh2",
        title: "New email from carol@example.com",
        body: "(no subject)",
      }),
    );

    // Missing from → "Unknown sender".
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "fresh3",
        title: "New email from Unknown sender",
      }),
    );

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "microsoft.email_arrived_notified",
      "u1",
      "dev",
      expect.objectContaining({ count: 4, unread_total: 6 }),
    );
  });

  it("malformed ?since= treated as first poll (no notify fan-out)", async () => {
    mockGetUser.mockReturnValue(USER);
    mockGetValidToken.mockResolvedValue({
      accessToken: "T",
      userEmail: "a@x.com",
    });
    (global as any).fetch.mockResolvedValue(
      mkGraphRes({
        "@odata.count": 1,
        value: [
          {
            id: "any",
            subject: "x",
            bodyPreview: "",
            receivedDateTime: "2030-01-01T00:00:00Z",
            isRead: false,
            from: {
              emailAddress: { name: "Z", address: "z@example.com" },
            },
          },
        ],
      }),
    );

    const { GET } = await import(
      "@/app/api/microsoft/messages/unread-count/route"
    );
    const res = await GET(
      mkReq(
        "/api/microsoft/messages/unread-count?since=not-a-date",
        "Bearer t",
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.since).toBeNull();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("notify() throw does not break the badge response", async () => {
    mockGetUser.mockReturnValue(USER);
    mockGetValidToken.mockResolvedValue({
      accessToken: "T",
      userEmail: "a@x.com",
    });
    (global as any).fetch.mockResolvedValue(
      mkGraphRes({
        "@odata.count": 1,
        value: [
          {
            id: "fresh",
            subject: "x",
            bodyPreview: "",
            receivedDateTime: "2030-01-01T00:00:00Z",
            isRead: false,
            from: {
              emailAddress: { name: "Z", address: "z@example.com" },
            },
          },
        ],
      }),
    );
    mockNotify.mockRejectedValue(new Error("db down"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    const since = "2026-04-29T00:00:00Z";
    const { GET } = await import(
      "@/app/api/microsoft/messages/unread-count/route"
    );
    const res = await GET(
      mkReq(
        `/api/microsoft/messages/unread-count?since=${encodeURIComponent(since)}`,
        "Bearer t",
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    warn.mockRestore();
  });
});
