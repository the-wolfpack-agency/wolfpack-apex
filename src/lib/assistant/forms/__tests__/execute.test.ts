/**
 * executeFormAction, the shared form-action executor.
 *
 * Pins the contract every caller (the human submit route and the future
 * agent on-behalf path) depends on:
 *   - each kind forwards to the correct internal path,
 *   - the caller's auth header is forwarded verbatim (never reconstructed),
 *   - the upstream POST body is shaped as the upstream route expects,
 *   - unknown kinds are not in KNOWN_FORM_KINDS and route to an error,
 *   - a fetch rejection surfaces (executor does not swallow it) so the
 *     route's outer try/catch turns it into an "internal" failure.
 *
 * HTTP-backed kinds are tested by mocking global.fetch. The CRM kind has
 * no HTTP hop (it calls the connector directly), so the connectors module
 * is mocked for those cases.
 */

const mockBuildRest = jest.fn();
const mockPickConfigured = jest.fn();
jest.mock("@/lib/assistant/connectors", () => ({
  buildRestConnectorForWorkspace: (...a: unknown[]) => mockBuildRest(...a),
  pickConfiguredConnector: (...a: unknown[]) => mockPickConfigured(...a),
}));

import {
  executeFormAction,
  KNOWN_FORM_KINDS,
  type FormKind,
} from "@/lib/assistant/forms/execute";

const ORIGIN = "https://internal.example";
const AUTH = "Bearer test-token-xyz";

/** Build a Response like the real internal routes return. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Read the last fetch call: returns { url, method, headers, body }. */
function lastFetch() {
  const fetchMock = global.fetch as jest.Mock;
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return {
    url: url as string,
    method: (init?.method as string) ?? "GET",
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: init?.body ? JSON.parse(init.body as string) : undefined,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn();
});

describe("KNOWN_FORM_KINDS", () => {
  test("covers exactly the seven supported kinds", () => {
    expect([...KNOWN_FORM_KINDS].sort()).toEqual(
      [
        "create_calendar_event",
        "create_crm_record",
        "create_email",
        "create_feature",
        "create_message",
        "create_okr",
        "create_task",
      ].sort(),
    );
  });

  test("does not include an unknown kind", () => {
    expect(KNOWN_FORM_KINDS.includes("create_bogus" as FormKind)).toBe(false);
  });
});

describe("auth header forwarding (security)", () => {
  test("forwards the caller's Authorization header verbatim, never reconstructed", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse(200, {}));
    await executeFormAction(
      "create_email",
      { to: "a@b.com", subject: "Hi", body: "Yo" },
      { origin: ORIGIN, authHeader: AUTH },
    );
    const f = lastFetch();
    expect((f.headers as Record<string, string>).Authorization).toBe(AUTH);
  });

  test("omits Authorization entirely when caller has no auth header", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse(200, {}));
    await executeFormAction(
      "create_email",
      { to: "a@b.com", subject: "Hi", body: "Yo" },
      { origin: ORIGIN, authHeader: null },
    );
    const f = lastFetch();
    expect((f.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  test("targets the trusted server origin passed in ctx, not a request host", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse(200, {}));
    await executeFormAction(
      "create_email",
      { to: "a@b.com", subject: "Hi", body: "Yo" },
      { origin: ORIGIN, authHeader: AUTH },
    );
    expect(lastFetch().url.startsWith(ORIGIN)).toBe(true);
  });
});

describe("create_email", () => {
  test("forwards to /api/mail/send with split recipients + subject + bodyText", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse(200, {}));
    const res = await executeFormAction(
      "create_email",
      { to: "a@b.com, c@d.com", cc: "e@f.com", subject: "Hi", body: "Body" },
      { origin: ORIGIN, authHeader: AUTH },
    );
    const f = lastFetch();
    expect(f.url).toBe(`${ORIGIN}/api/mail/send`);
    expect(f.method).toBe("POST");
    expect(f.body).toEqual({
      to: ["a@b.com", "c@d.com"],
      cc: ["e@f.com"],
      subject: "Hi",
      bodyText: "Body",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  test("missing required fields short-circuits with validation (no fetch)", async () => {
    const res = await executeFormAction(
      "create_email",
      { to: "", subject: "", body: "" },
      { origin: ORIGIN, authHeader: AUTH },
    );
    expect(res.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.code).toBe("validation");
    expect(body.fieldErrors).toMatchObject({ to: "Required", subject: "Required", body: "Required" });
  });

  test("upstream 403 maps to scope failure", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse(403, {}));
    const res = await executeFormAction(
      "create_email",
      { to: "a@b.com", subject: "Hi", body: "Body" },
      { origin: ORIGIN, authHeader: AUTH },
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("scope");
  });
});

describe("create_calendar_event", () => {
  test("forwards to /api/calendar/events with attendees + bodyText", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse(200, { id: "evt-1" }));
    const res = await executeFormAction(
      "create_calendar_event",
      {
        subject: "Sync",
        start: "2026-07-01T10:00",
        end: "2026-07-01T11:00",
        attendees: "x@y.com; z@y.com",
        body: "agenda",
      },
      { origin: ORIGIN, authHeader: AUTH },
    );
    const f = lastFetch();
    expect(f.url).toBe(`${ORIGIN}/api/calendar/events`);
    expect(f.body).toEqual({
      subject: "Sync",
      start: "2026-07-01T10:00",
      end: "2026-07-01T11:00",
      attendees: ["x@y.com", "z@y.com"],
      bodyText: "agenda",
    });
    expect((await res.json()).resourceId).toBe("evt-1");
  });

  test("end before start is a field error (no fetch)", async () => {
    const res = await executeFormAction(
      "create_calendar_event",
      { subject: "S", start: "2026-07-01T11:00", end: "2026-07-01T10:00" },
      { origin: ORIGIN, authHeader: AUTH },
    );
    expect(res.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
    expect((await res.json()).fieldErrors.end).toMatch(/after start/);
  });
});

describe("create_task", () => {
  test("forwards to /api/tasks with listId + title", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      jsonResponse(200, { task: { id: "t-9" } }),
    );
    const res = await executeFormAction(
      "create_task",
      { title: "Do it", listId: "list-1", body: "notes", dueAt: "2026-07-02", importance: "high" },
      { origin: ORIGIN, authHeader: AUTH },
    );
    const f = lastFetch();
    expect(f.url).toBe(`${ORIGIN}/api/tasks`);
    expect(f.body).toEqual({
      listId: "list-1",
      title: "Do it",
      body: "notes",
      dueAt: "2026-07-02",
      importance: "high",
    });
    expect((await res.json()).resourceId).toBe("t-9");
  });

  test("'default' listId sentinel is rejected before forwarding", async () => {
    const res = await executeFormAction(
      "create_task",
      { title: "Do it", listId: "default" },
      { origin: ORIGIN, authHeader: AUTH },
    );
    expect(res.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
    expect((await res.json()).fieldErrors.listId).toMatch(/Pick a To-Do list/);
  });
});

describe("create_okr", () => {
  test("forwards to /api/goals/okrs with a single KR", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      jsonResponse(200, { okr: { id: "okr-3" } }),
    );
    const res = await executeFormAction(
      "create_okr",
      { quarter: "Q3-2026", objective: "Grow", kr_metric: "ARR", kr_target: "100", kr_unit: "k" },
      { origin: ORIGIN, authHeader: AUTH },
    );
    const f = lastFetch();
    expect(f.url).toBe(`${ORIGIN}/api/goals/okrs`);
    expect(f.body).toEqual({
      quarter: "Q3-2026",
      objective: "Grow",
      krs: [{ metric: "ARR", target: 100, unit: "k" }],
    });
    expect((await res.json()).resourceId).toBe("okr-3");
  });

  test("non-numeric kr_target is a field error", async () => {
    const res = await executeFormAction(
      "create_okr",
      { quarter: "Q3", objective: "Grow", kr_metric: "ARR", kr_target: "lots" },
      { origin: ORIGIN, authHeader: AUTH },
    );
    expect(res.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
    expect((await res.json()).fieldErrors.kr_target).toMatch(/number/);
  });

  test("upstream 403 maps to scope (role-gated)", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse(403, {}));
    const res = await executeFormAction(
      "create_okr",
      { quarter: "Q3", objective: "Grow", kr_metric: "ARR", kr_target: "100" },
      { origin: ORIGIN, authHeader: AUTH },
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("scope");
  });
});

describe("create_feature", () => {
  test("forwards to /api/features with optional fields", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse(200, { id: "feat-2" }));
    const res = await executeFormAction(
      "create_feature",
      {
        title: "Dark mode",
        description: "Please",
        target_product: "web",
        priority: "high",
        category: "ux",
      },
      { origin: ORIGIN, authHeader: AUTH },
    );
    const f = lastFetch();
    expect(f.url).toBe(`${ORIGIN}/api/features`);
    expect(f.body).toEqual({
      title: "Dark mode",
      description: "Please",
      target_product: "web",
      priority: "high",
      category: "ux",
    });
    expect((await res.json()).resourceId).toBe("feat-2");
  });

  test("missing title + description is a validation failure (no fetch)", async () => {
    const res = await executeFormAction(
      "create_feature",
      { title: "", description: "" },
      { origin: ORIGIN, authHeader: AUTH },
    );
    expect(res.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("create_message", () => {
  test("forwards to /api/ms/chats/{chatId}/messages when chatId given (no lookup)", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse(200, {}));
    const res = await executeFormAction(
      "create_message",
      { chatId: "chat-1", body: "Hello" },
      { origin: ORIGIN, authHeader: AUTH },
    );
    const f = lastFetch();
    expect(f.url).toBe(`${ORIGIN}/api/ms/chats/chat-1/messages`);
    expect(f.body).toEqual({ content: "Hello", contentType: "text" });
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
    expect(res.status).toBe(200);
  });

  test("resolves recipient via GET /api/ms/chats then posts to the matched chat", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(
        jsonResponse(200, {
          chats: [
            { id: "chat-7", members: [{ displayName: "Alice Smith", email: "alice@x.com" }] },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, {}));
    const res = await executeFormAction(
      "create_message",
      { recipient: "alice@x.com", body: "Hi Alice" },
      { origin: ORIGIN, authHeader: AUTH },
    );
    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(calls[0][0]).toBe(`${ORIGIN}/api/ms/chats?match=${encodeURIComponent("alice@x.com")}`);
    expect(calls[1][0]).toBe(`${ORIGIN}/api/ms/chats/chat-7/messages`);
    expect(res.status).toBe(200);
  });

  test("no matching chat surfaces a validation failure", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse(200, { chats: [] }));
    const res = await executeFormAction(
      "create_message",
      { recipient: "nobody@x.com", body: "Hi" },
      { origin: ORIGIN, authHeader: AUTH },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).fieldErrors.recipient).toBe("No matching chat");
  });
});

describe("create_crm_record (connector path, no HTTP hop)", () => {
  function configuredConnector(createResult: unknown) {
    return {
      isConfigured: () => true,
      createRecord: jest.fn().mockResolvedValue(createResult),
    };
  }

  test("creates a deal through the workspace connector and returns its id", async () => {
    mockPickConfigured.mockResolvedValue("salesforce");
    const connector = configuredConnector({ ok: true, data: { id: "deal-42" } });
    mockBuildRest.mockResolvedValue(connector);

    const res = await executeFormAction(
      "create_crm_record",
      { objectType: "deal", name: "Acme", amount: "$50,000", stage: "Prospect", closeDate: "2026-09-01" },
      { origin: ORIGIN, authHeader: AUTH, extra: { workspaceId: "ws-1" } },
    );

    expect(mockBuildRest).toHaveBeenCalledWith("ws-1", "salesforce");
    expect(connector.createRecord).toHaveBeenCalledWith("deal", {
      Name: "Acme",
      Amount: 50000,
      StageName: "Prospect",
      CloseDate: "2026-09-01",
    });
    expect(global.fetch).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, resourceId: "deal-42" });
  });

  test("defaults workspaceId to 'default' when extra omitted", async () => {
    mockPickConfigured.mockResolvedValue("rest-default");
    mockBuildRest.mockResolvedValue(configuredConnector({ ok: true, data: { id: "c-1" } }));
    await executeFormAction(
      "create_crm_record",
      { objectType: "account", name: "Globex" },
      { origin: ORIGIN, authHeader: AUTH },
    );
    expect(mockBuildRest).toHaveBeenCalledWith("default", "rest-default");
  });

  test("unconfigured connector returns a validation failure", async () => {
    mockPickConfigured.mockResolvedValue("salesforce");
    mockBuildRest.mockResolvedValue({ isConfigured: () => false });
    const res = await executeFormAction(
      "create_crm_record",
      { objectType: "account", name: "Globex" },
      { origin: ORIGIN, authHeader: AUTH, extra: { workspaceId: "ws-1" } },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation");
  });

  test("connector auth_failed maps to an auth failure", async () => {
    mockPickConfigured.mockResolvedValue("salesforce");
    mockBuildRest.mockResolvedValue(
      configuredConnector({ ok: false, code: "auth_failed", message: "expired" }),
    );
    const res = await executeFormAction(
      "create_crm_record",
      { objectType: "account", name: "Globex" },
      { origin: ORIGIN, authHeader: AUTH, extra: { workspaceId: "ws-1" } },
    );
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth");
  });

  test("unknown CRM objectType is a validation failure", async () => {
    const res = await executeFormAction(
      "create_crm_record",
      { objectType: "spaceship" },
      { origin: ORIGIN, authHeader: AUTH, extra: { workspaceId: "ws-1" } },
    );
    expect(res.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("unrouted + fetch-failure error paths", () => {
  test("an unknown kind routes to an internal failure", async () => {
    const res = await executeFormAction(
      "create_bogus" as FormKind,
      {},
      { origin: ORIGIN, authHeader: AUTH },
    );
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("internal");
  });

  test("a fetch rejection propagates (executor does not swallow it)", async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(
      executeFormAction(
        "create_email",
        { to: "a@b.com", subject: "Hi", body: "Body" },
        { origin: ORIGIN, authHeader: AUTH },
      ),
    ).rejects.toThrow("ECONNREFUSED");
  });
});
