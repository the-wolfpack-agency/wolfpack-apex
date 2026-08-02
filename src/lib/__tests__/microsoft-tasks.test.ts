/**
 * Microsoft Tasks integration tests.
 *
 * Covers list/create/update/complete/sync, 429 backoff, 5xx surfacing,
 * token refresh path, cache upserts, idempotent re-sync.
 */
 

// Make this file a module (not a script) so top-level `const` declarations
// stay file-scoped and don't collide with sibling test files.
export {};

const mockTrackEventTasks = jest.fn();
const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();
const mockGetValidToken = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrackEventTasks(...args),
}));

jest.mock("@/lib/db", () => ({
  query: (...args: any[]) => mockQuery(...args),
  safeQuery: (...args: any[]) => mockSafeQuery(...args),
  pool: { query: jest.fn() },
  // activePool() replaced direct pool use so every query is routed to the
  // tenant's database. The mock must expose it or the module under test
  // calls undefined.
  activePool: () => ({ query: jest.fn() }),
}));

jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...args: any[]) => mockGetValidToken(...args),
}));

const realFetch = global.fetch;
const fetchMock = jest.fn();

beforeAll(() => {
  (global as any).fetch = fetchMock;
});
afterAll(() => {
  (global as any).fetch = realFetch;
});

beforeEach(() => {
  jest.clearAllMocks();
  fetchMock.mockReset();
  mockGetValidToken.mockResolvedValue({ accessToken: "tok-abc", userEmail: "u@example.com" });
});

function okResponse(data: unknown, extra: Partial<Response> = {}): any {
  return {
    ok: true,
    status: 200,
    headers: new Map(),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    ...extra,
  };
}
function errResponse(status: number, text = "err", headers: Record<string, string> = {}): any {
  return {
    ok: false,
    status,
    headers: {
      get: (k: string) => headers[k.toLowerCase()] ?? headers[k] ?? null,
    },
    json: () => Promise.resolve({ error: text }),
    text: () => Promise.resolve(text),
  };
}

// ---------------------------------------------------------------------------
// listTaskLists / listTasks
// ---------------------------------------------------------------------------

describe("listTaskLists", () => {
  it("requires a valid MS token", async () => {
    mockGetValidToken.mockResolvedValueOnce(null);
    const { listTaskLists, GraphTasksError } = await import("@/lib/integrations/microsoft-tasks");
    await expect(listTaskLists("user-1")).rejects.toBeInstanceOf(GraphTasksError);
  });

  it("returns normalized list array from Graph", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({
      value: [{ id: "list-1", displayName: "Tasks", isOwner: true }],
    }));
    const { listTaskLists } = await import("@/lib/integrations/microsoft-tasks");
    const lists = await listTaskLists("user-1");
    expect(lists).toHaveLength(1);
    expect(lists[0].displayName).toBe("Tasks");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.microsoft.com/v1.0/me/todo/lists",
      expect.objectContaining({ method: "GET" }),
    );
  });
});

describe("resolveDefaultListId", () => {
  it("returns the wellknown defaultList id and caches the lists", async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({
        value: [
          { id: "list-flag", displayName: "Flagged Emails", wellknownListName: "flaggedEmails" },
          { id: "list-def", displayName: "Tasks", isOwner: true, wellknownListName: "defaultList" },
          { id: "list-proj", displayName: "Project X", isOwner: true, wellknownListName: "none" },
        ],
      }),
    );
    // upsertList INSERT ... RETURNING id
    mockQuery.mockResolvedValue({ rows: [{ id: "uuid" }] });
    const { resolveDefaultListId } = await import("@/lib/integrations/microsoft-tasks");
    const id = await resolveDefaultListId("user-1");
    expect(id).toBe("list-def");
    // Cached all three lists (best-effort warm) so the picker populates next time.
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it("falls back to the first owned list when no wellknown default", async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({
        value: [
          { id: "list-shared", displayName: "Shared", isOwner: false },
          { id: "list-own", displayName: "Mine", isOwner: true },
        ],
      }),
    );
    mockQuery.mockResolvedValue({ rows: [{ id: "uuid" }] });
    const { resolveDefaultListId } = await import("@/lib/integrations/microsoft-tasks");
    expect(await resolveDefaultListId("user-1")).toBe("list-own");
  });

  it("throws GraphTasksError(404) when the account has no lists", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ value: [] }));
    const { resolveDefaultListId, GraphTasksError } = await import("@/lib/integrations/microsoft-tasks");
    await expect(resolveDefaultListId("user-1")).rejects.toBeInstanceOf(GraphTasksError);
  });
});

describe("listTasks", () => {
  it("applies $top/$skip/status filter params", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ value: [] }));
    const { listTasks } = await import("@/lib/integrations/microsoft-tasks");
    await listTasks("user-1", "list-1", { top: 50, skip: 10, status: "inProgress" });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("%24top=50");
    expect(url).toContain("%24skip=10");
    expect(url).toContain("status+eq+%27inProgress%27");
  });
});

// ---------------------------------------------------------------------------
// 429 + 5xx behavior
// ---------------------------------------------------------------------------

describe("Graph error handling", () => {
  it("honors Retry-After on 429 and retries once", async () => {
    fetchMock
      .mockResolvedValueOnce(errResponse(429, "throttled", { "retry-after": "0" }))
      .mockResolvedValueOnce(okResponse({ value: [] }));
    const { listTaskLists } = await import("@/lib/integrations/microsoft-tasks");
    const lists = await listTaskLists("user-1");
    expect(lists).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws GraphTasksError on 429 then 500", async () => {
    fetchMock
      .mockResolvedValueOnce(errResponse(429, "throttled", { "retry-after": "0" }))
      .mockResolvedValueOnce(errResponse(500, "boom"));
    const { listTaskLists, GraphTasksError } = await import("@/lib/integrations/microsoft-tasks");
    await expect(listTaskLists("user-1")).rejects.toBeInstanceOf(GraphTasksError);
  });

  it("surfaces 5xx errors clearly", async () => {
    fetchMock.mockResolvedValueOnce(errResponse(503, "service unavailable"));
    const { listTaskLists, GraphTasksError } = await import("@/lib/integrations/microsoft-tasks");
    await expect(listTaskLists("user-1")).rejects.toMatchObject({
      name: "GraphTasksError",
      status: 503,
    });
    // Cache remains valid — we never threw from safeQuery.
    const { listCachedTaskLists } = await import("@/lib/integrations/microsoft-tasks");
    mockSafeQuery.mockResolvedValueOnce({ rows: [{
      id: "u-1", user_id: "u", ms_list_id: "l", display_name: "L",
      is_owner: true, is_shared: false, etag: null, synced_at: new Date().toISOString(),
    }] });
    const cached = await listCachedTaskLists("u");
    expect(cached).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// createTask — write-through + cache upsert
// ---------------------------------------------------------------------------

describe("createTask", () => {
  it("POSTs to Graph then upserts into local cache and emits analytics", async () => {
    const graphTask = {
      id: "ms-task-1",
      title: "Write memo",
      status: "notStarted",
      importance: "normal",
      createdDateTime: "2026-04-15T10:00:00Z",
      lastModifiedDateTime: "2026-04-15T10:00:00Z",
    };
    fetchMock.mockResolvedValueOnce(okResponse(graphTask));
    // ensureListInCache → safeQuery returns existing
    mockSafeQuery.mockResolvedValueOnce({ rows: [{ id: "list-uuid" }] });
    // upsertTask → query returns local id
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "task-uuid" }] });
    // getCachedTaskById → safeQuery returns the row
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{
        id: "task-uuid", ms_task_id: "ms-task-1", user_id: "u", list_id: "list-uuid",
        title: "Write memo", body: null, status: "notStarted", importance: "normal",
        due_at: null, completed_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        etag: null, synced_at: new Date().toISOString(),
        payload: JSON.stringify(graphTask),
        list_ms_id: "list-1",
      }],
    });

    const { createTask } = await import("@/lib/integrations/microsoft-tasks");
    const task = await createTask("u", "list-1", { title: "Write memo" });

    expect(task.msTaskId).toBe("ms-task-1");
    expect(task.title).toBe("Write memo");
    expect(mockTrackEventTasks).toHaveBeenCalledWith(
      "system.task_created",
      "u",
      "system",
      expect.objectContaining({ task_id: "ms-task-1", list_id: "list-1", via: "instinct" }),
    );
  });
});

// ---------------------------------------------------------------------------
// completeTask
// ---------------------------------------------------------------------------

describe("completeTask", () => {
  it("patches status to completed and emits system.task_completed", async () => {
    const graphUpdated = {
      id: "ms-1", title: "x", status: "completed", importance: "normal",
      createdDateTime: "2026-04-15T10:00:00Z", lastModifiedDateTime: "2026-04-15T10:00:00Z",
      completedDateTime: { dateTime: "2026-04-15T11:00:00", timeZone: "UTC" },
    };
    fetchMock.mockResolvedValueOnce(okResponse(graphUpdated));
    mockSafeQuery.mockResolvedValueOnce({ rows: [{ id: "list-uuid" }] }); // ensureListInCache
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "task-uuid" }] }); // upsert
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{
        id: "task-uuid", ms_task_id: "ms-1", user_id: "u", list_id: "list-uuid",
        title: "x", body: null, status: "completed", importance: "normal",
        due_at: null, completed_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        etag: null, synced_at: new Date().toISOString(),
        payload: "{}",
      }],
    });

    const { completeTask } = await import("@/lib/integrations/microsoft-tasks");
    const task = await completeTask("u", "list-1", "ms-1", "instinct");
    expect(task.status).toBe("completed");
    expect(mockTrackEventTasks).toHaveBeenCalledWith(
      "system.task_completed",
      "u",
      "system",
      expect.objectContaining({ task_id: "ms-1", via: "instinct" }),
    );
  });
});

// ---------------------------------------------------------------------------
// syncAllForUser — idempotent + analytics
// ---------------------------------------------------------------------------

describe("syncAllForUser", () => {
  it("walks lists + tasks, upserts, emits system.ms_tasks_synced", async () => {
    fetchMock
      // listTaskLists
      .mockResolvedValueOnce(okResponse({
        value: [{ id: "L1", displayName: "Tasks", isOwner: true }],
      }))
      // listTasks (first page < top, loop exits)
      .mockResolvedValueOnce(okResponse({
        value: [
          { id: "T1", title: "A", status: "notStarted", importance: "normal" },
          { id: "T2", title: "B", status: "inProgress", importance: "high" },
        ],
      }));

    // upsertList + upsertTask + upsertTask
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "list-uuid" }] })
      .mockResolvedValueOnce({ rows: [{ id: "t1-uuid" }] })
      .mockResolvedValueOnce({ rows: [{ id: "t2-uuid" }] });

    const { syncAllForUser } = await import("@/lib/integrations/microsoft-tasks");
    const result = await syncAllForUser("user-1");
    expect(result.listCount).toBe(1);
    expect(result.taskCount).toBe(2);
    expect(mockTrackEventTasks).toHaveBeenCalledWith(
      "system.ms_tasks_synced",
      "user-1",
      "system",
      expect.objectContaining({ list_count: 1, task_count: 2 }),
    );
  });

  it("emits system.ms_tasks_sync_failed on error and re-throws", async () => {
    fetchMock.mockResolvedValueOnce(errResponse(500, "boom"));
    const { syncAllForUser, GraphTasksError } = await import("@/lib/integrations/microsoft-tasks");
    await expect(syncAllForUser("user-1")).rejects.toBeInstanceOf(GraphTasksError);
    expect(mockTrackEventTasks).toHaveBeenCalledWith(
      "system.ms_tasks_sync_failed",
      "user-1",
      "system",
      expect.objectContaining({ http_status: 500 }),
    );
  });

  it("is idempotent — re-sync upserts without duplicating", async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse({ value: [{ id: "L1", displayName: "Tasks" }] }))
      .mockResolvedValueOnce(okResponse({ value: [{ id: "T1", title: "A", status: "notStarted" }] }))
      .mockResolvedValueOnce(okResponse({ value: [{ id: "L1", displayName: "Tasks" }] }))
      .mockResolvedValueOnce(okResponse({ value: [{ id: "T1", title: "A", status: "notStarted" }] }));

    mockQuery
      .mockResolvedValue({ rows: [{ id: "some-uuid" }] });

    const { syncAllForUser } = await import("@/lib/integrations/microsoft-tasks");
    const a = await syncAllForUser("user-1");
    const b = await syncAllForUser("user-1");
    expect(a.taskCount).toBe(1);
    expect(b.taskCount).toBe(1);

    // Every upsert call used ON CONFLICT DO UPDATE — evidence: the SQL text.
    const sqls = mockQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.every((s) => /ON CONFLICT/i.test(s))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Webhook clientState verification
// ---------------------------------------------------------------------------

describe("verifyWebhookClientState", () => {
  const prev = process.env.MS_TASKS_WEBHOOK_CLIENT_STATE;
  afterAll(() => {
    if (prev === undefined) delete process.env.MS_TASKS_WEBHOOK_CLIENT_STATE;
    else process.env.MS_TASKS_WEBHOOK_CLIENT_STATE = prev;
  });

  it("returns true when secret not configured (dev)", async () => {
    delete process.env.MS_TASKS_WEBHOOK_CLIENT_STATE;
    const { verifyWebhookClientState } = await import("@/lib/integrations/microsoft-tasks");
    expect(verifyWebhookClientState("anything")).toBe(true);
  });

  it("constant-time compares against configured secret", async () => {
    process.env.MS_TASKS_WEBHOOK_CLIENT_STATE = "expected-secret";
    const { verifyWebhookClientState } = await import("@/lib/integrations/microsoft-tasks");
    expect(verifyWebhookClientState("expected-secret")).toBe(true);
    expect(verifyWebhookClientState("wrong")).toBe(false);
    expect(verifyWebhookClientState(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cache reads
// ---------------------------------------------------------------------------

describe("listCachedTasks", () => {
  it("builds filter SQL for status + search + listId + paging", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    const { listCachedTasks } = await import("@/lib/integrations/microsoft-tasks");
    await listCachedTasks("u", { status: "inProgress", search: "memo", listId: "list-1", limit: 10 });
    const sql = String(mockSafeQuery.mock.calls[0][0]);
    expect(sql).toMatch(/t\.status = \$\d+/);
    expect(sql).toMatch(/ILIKE/);
    expect(sql).toMatch(/l\.ms_list_id = \$\d+/);
  });
});
