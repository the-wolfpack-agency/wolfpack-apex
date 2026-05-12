/**
 * Microsoft Planner integration tests.
 *
 * Covers listPlansForGroup, listBuckets, listTasks, getTask, createTask,
 * updateTask (etag happy path + 412 etag_conflict), completeTask (notify
 * fan-out), syncAllForUser (pagination + 429 backoff), 403 scope_missing.
 */
 

// Make this file a module (not a script) so top-level `const` declarations
// stay file-scoped under tsconfig's `isolatedModules`.
export {};

const mockTrack = jest.fn();
const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();
const mockGetValidToken = jest.fn();
const mockRecordAudit = jest.fn();
const mockNotify = jest.fn();
const mockSaveAnswer = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrack(...args),
}));

jest.mock("@/lib/db", () => ({
  query: (...args: any[]) => mockQuery(...args),
  safeQuery: (...args: any[]) => mockSafeQuery(...args),
  pool: { query: jest.fn() },
}));

jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...args: any[]) => mockGetValidToken(...args),
}));

jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...args: any[]) => mockRecordAudit(...args),
}));

jest.mock("@/lib/notifications/in-app", () => ({
  notify: (...args: any[]) => mockNotify(...args),
}));

jest.mock("@/lib/knowledge", () => ({
  saveAnswer: (...args: any[]) => mockSaveAnswer(...args),
}));

const realFetch = global.fetch;
const fetchMock = jest.fn();

beforeAll(() => { (global as any).fetch = fetchMock; });
afterAll(() => { (global as any).fetch = realFetch; });

beforeEach(() => {
  jest.clearAllMocks();
  fetchMock.mockReset();
  mockGetValidToken.mockResolvedValue({ accessToken: "tok-abc", userEmail: "u@example.com" });
  mockRecordAudit.mockResolvedValue({ id: "a", seq: 1, entryHash: "h" });
  mockNotify.mockResolvedValue({ id: "n" });
  mockSaveAnswer.mockResolvedValue(null);
});

function ok(data: unknown, headers: Record<string, string> = {}): any {
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}
function okEmpty(status = 204, headers: Record<string, string> = {}): any {
  return {
    ok: true,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: () => Promise.resolve(null),
    text: () => Promise.resolve(""),
  };
}
function err(status: number, body: any = {}, headers: Record<string, string> = {}): any {
  return {
    ok: false,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

const UUID = "11111111-1111-1111-1111-111111111111";
const UUID2 = "22222222-2222-2222-2222-222222222222";

// ---------------------------------------------------------------------------
// listPlansForGroup
// ---------------------------------------------------------------------------

describe("listPlansForGroup", () => {
  it("reads cached group row + fetches plans + upserts", async () => {
    // resolve group by local UUID
    mockSafeQuery.mockResolvedValueOnce({ rows: [{ id: UUID, ms_group_id: "grp-1" }] });
    fetchMock.mockResolvedValueOnce(ok({
      value: [
        { id: "plan-1", title: "Roadmap", container: { containerId: "grp-1", type: "group" },
          createdBy: { user: { id: "creator" } }, createdDateTime: "2026-04-01T00:00:00Z" },
      ],
    }));
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "plan-local-1" }] }); // upsertPlan
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{
        id: "plan-local-1", user_id: "u", group_id: UUID, ms_group_id: "grp-1",
        ms_plan_id: "plan-1", ms_container_id: "grp-1", ms_container_type: "group",
        title: "Roadmap", created_by: {}, created_at: null, etag: null,
        synced_at: new Date().toISOString(),
      }],
    });

    const { listPlansForGroup } = await import("@/lib/integrations/microsoft-planner");
    const res = await listPlansForGroup("u", UUID);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error();
    expect(res.value).toHaveLength(1);
    expect(res.value[0].title).toBe("Roadmap");
  });

  it("returns not_found when group UUID not in cache", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    const { listPlansForGroup } = await import("@/lib/integrations/microsoft-planner");
    const res = await listPlansForGroup("u", UUID);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.code).toBe("not_found");
  });

  it("returns scope_missing on 403", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [{ id: UUID, ms_group_id: "g" }] });
    fetchMock.mockResolvedValueOnce(err(403, { error: { code: "AccessDenied", message: "forbidden" } }));
    const { listPlansForGroup } = await import("@/lib/integrations/microsoft-planner");
    const res = await listPlansForGroup("u", UUID);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.code).toBe("scope_missing");
  });
});

// ---------------------------------------------------------------------------
// listBuckets
// ---------------------------------------------------------------------------

describe("listBuckets", () => {
  it("returns from cache when present", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [{ id: UUID, ms_plan_id: "plan-1" }] }) // resolvePlanIds
      .mockResolvedValueOnce({ rows: [
        { id: "b1", plan_id: UUID, ms_bucket_id: "ms-b1", name: "To Do",
          order_hint: "1", etag: null, synced_at: new Date().toISOString() },
      ] });
    const { listBuckets } = await import("@/lib/integrations/microsoft-planner");
    const res = await listBuckets("u", UUID);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error();
    expect(res.value).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to Graph on cache miss + upserts", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [{ id: UUID, ms_plan_id: "plan-1" }] })
      .mockResolvedValueOnce({ rows: [] });
    fetchMock.mockResolvedValueOnce(ok({
      value: [{ id: "ms-b1", name: "Backlog", orderHint: "1" }],
    }));
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "b-local-1" }] });

    const { listBuckets } = await import("@/lib/integrations/microsoft-planner");
    const res = await listBuckets("u", UUID);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error();
    expect(res.value).toHaveLength(1);
    expect(res.value[0].name).toBe("Backlog");
  });
});

// ---------------------------------------------------------------------------
// listTasks (cache read)
// ---------------------------------------------------------------------------

describe("listTasks", () => {
  it("builds filter SQL for percent_complete, assignee, search", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [{ id: UUID, ms_plan_id: "plan-1" }] })
      .mockResolvedValueOnce({ rows: [] });
    const { listTasks } = await import("@/lib/integrations/microsoft-planner");
    await listTasks("u", UUID, { percentComplete: 50, assigneeUserId: "user-x", search: "alpha" });
    const sql = String(mockSafeQuery.mock.calls[1][0]);
    expect(sql).toMatch(/percent_complete = \$\d+/);
    expect(sql).toMatch(/assignees @> \$\d+::jsonb/);
    expect(sql).toMatch(/title ILIKE/);
  });

  it("paginates with nextCursor", async () => {
    const now = new Date().toISOString();
    const baseTask = (id: string) => ({
      id, user_id: "u", plan_id: UUID, bucket_id: null, ms_task_id: `m${id}`,
      title: "t", due_at: null, start_at: null, percent_complete: 0, priority: 5,
      assignees: [], created_by: {}, created_at: now, updated_at: now,
      completed_at: null, etag: null, synced_at: now, payload: {},
    });
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [{ id: UUID, ms_plan_id: "plan-1" }] })
      .mockResolvedValueOnce({ rows: [baseTask("1"), baseTask("2"), baseTask("3")] });
    const { listTasks } = await import("@/lib/integrations/microsoft-planner");
    const res = await listTasks("u", UUID, { limit: 2 });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error();
    expect(res.value.tasks).toHaveLength(2);
    expect(res.value.nextCursor).toBe("2");
  });
});

// ---------------------------------------------------------------------------
// getTask
// ---------------------------------------------------------------------------

describe("getTask", () => {
  it("returns null when not in cache", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    const { getTask } = await import("@/lib/integrations/microsoft-planner");
    const res = await getTask("u", "ms-task-x");
    expect(res).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createTask
// ---------------------------------------------------------------------------

describe("createTask", () => {
  it("POSTs to Graph, upserts, emits analytics + audit, returns task", async () => {
    // resolvePlanIds
    mockSafeQuery.mockResolvedValueOnce({ rows: [{ id: UUID, ms_plan_id: "plan-1" }] });
    // resolveBucketIds
    mockSafeQuery.mockResolvedValueOnce({ rows: [{ id: UUID2, ms_bucket_id: "ms-b1" }] });
    // graph POST
    fetchMock.mockResolvedValueOnce(ok({
      id: "new-task",
      title: "Ship",
      planId: "plan-1",
      percentComplete: 0,
      priority: 5,
      createdDateTime: "2026-04-15T10:00:00Z",
      lastModifiedDateTime: "2026-04-15T10:00:00Z",
      "@odata.etag": "W/\"v1\"",
    }));
    // upsertTask
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "t-local" }] });
    // getTaskByLocalId
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{
        id: "t-local", user_id: "u", plan_id: UUID, bucket_id: UUID2,
        ms_task_id: "new-task", title: "Ship", due_at: null, start_at: null,
        percent_complete: 0, priority: 5, assignees: [], created_by: {},
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        completed_at: null, etag: "W/\"v1\"", synced_at: new Date().toISOString(),
        payload: {},
      }],
    });

    const { createTask } = await import("@/lib/integrations/microsoft-planner");
    const res = await createTask("u", "cto", { planId: UUID, bucketId: UUID2, title: "Ship" });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error();
    expect(res.value.task.title).toBe("Ship");
    expect(mockTrack).toHaveBeenCalledWith(
      "system.ms_planner_task_created",
      "u",
      "cto",
      expect.objectContaining({ task_id: "new-task" }),
    );
    expect(mockRecordAudit).toHaveBeenCalled();
    expect(mockSaveAnswer).toHaveBeenCalled();
  });

  it("rejects empty title with invalid_input", async () => {
    const { createTask } = await import("@/lib/integrations/microsoft-planner");
    const res = await createTask("u", "cto", { planId: UUID, title: "   " });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.code).toBe("invalid_input");
  });

  it("returns not_found when plan not in cache", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    const { createTask } = await import("@/lib/integrations/microsoft-planner");
    const res = await createTask("u", "cto", { planId: UUID, title: "X" });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.code).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// updateTask — etag happy path + 412
// ---------------------------------------------------------------------------

describe("updateTask", () => {
  it("sends If-Match header + re-fetches to update cache", async () => {
    // getTask lookup
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{
        id: UUID2, user_id: "u", plan_id: UUID, bucket_id: null,
        ms_task_id: "ms-task-1", title: "Old", due_at: null, start_at: null,
        percent_complete: 0, priority: 5, assignees: [], created_by: {},
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        completed_at: null, etag: "W/\"v1\"", synced_at: new Date().toISOString(),
        payload: {},
      }],
    });
    // PATCH 204
    fetchMock.mockResolvedValueOnce(okEmpty(204));
    // GET fresh
    fetchMock.mockResolvedValueOnce(ok({
      id: "ms-task-1", title: "New", percentComplete: 50, priority: 5,
      "@odata.etag": "W/\"v2\"",
    }));
    mockQuery.mockResolvedValueOnce({ rows: [{ id: UUID2 }] });
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{
        id: UUID2, user_id: "u", plan_id: UUID, bucket_id: null,
        ms_task_id: "ms-task-1", title: "New", due_at: null, start_at: null,
        percent_complete: 50, priority: 5, assignees: [], created_by: {},
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        completed_at: null, etag: "W/\"v2\"", synced_at: new Date().toISOString(),
        payload: {},
      }],
    });

    const { updateTask } = await import("@/lib/integrations/microsoft-planner");
    const res = await updateTask("u", "cto", "ms-task-1", { title: "New", percentComplete: 50 }, "W/\"v1\"");
    expect(res.ok).toBe(true);

    // Confirm If-Match header was set on the PATCH.
    const patchHeaders = fetchMock.mock.calls[0][1].headers;
    expect(patchHeaders["If-Match"]).toBe("W/\"v1\"");
  });

  it("returns etag_conflict on 412 + re-fetches to refresh cache", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{
        id: UUID2, user_id: "u", plan_id: UUID, bucket_id: null,
        ms_task_id: "ms-task-1", title: "Old", due_at: null, start_at: null,
        percent_complete: 0, priority: 5, assignees: [], created_by: {},
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        completed_at: null, etag: "W/\"stale\"", synced_at: new Date().toISOString(),
        payload: {},
      }],
    });
    fetchMock.mockResolvedValueOnce(err(412, { error: { code: "PreconditionFailed" } }));
    // refresh GET
    fetchMock.mockResolvedValueOnce(ok({
      id: "ms-task-1", title: "Server Version", percentComplete: 30, priority: 5,
      "@odata.etag": "W/\"v99\"",
    }));
    mockQuery.mockResolvedValueOnce({ rows: [{ id: UUID2 }] });

    const { updateTask } = await import("@/lib/integrations/microsoft-planner");
    const res = await updateTask("u", "cto", "ms-task-1", { title: "Mine" }, "W/\"stale\"");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.code).toBe("etag_conflict");
    expect(mockTrack).toHaveBeenCalledWith(
      "system.ms_planner_sync_failed",
      "u",
      "cto",
      expect.objectContaining({ code: "etag_conflict" }),
    );
  });
});

// ---------------------------------------------------------------------------
// completeTask — notify fan-out
// ---------------------------------------------------------------------------

describe("completeTask", () => {
  it("emits system.ms_planner_task_completed + notifies other assignees", async () => {
    // getTask — existing with two assignees (user + teammate)
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{
        id: UUID2, user_id: "u", plan_id: UUID, bucket_id: null,
        ms_task_id: "ms-task-1", title: "Big one", due_at: null, start_at: null,
        percent_complete: 0, priority: 5, assignees: ["u", "teammate"],
        created_by: {}, created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(), completed_at: null,
        etag: "W/\"v1\"", synced_at: new Date().toISOString(), payload: {},
      }],
    });
    // updateTask → getTask (inner)
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{
        id: UUID2, user_id: "u", plan_id: UUID, bucket_id: null,
        ms_task_id: "ms-task-1", title: "Big one", due_at: null, start_at: null,
        percent_complete: 0, priority: 5, assignees: ["u", "teammate"],
        created_by: {}, created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(), completed_at: null,
        etag: "W/\"v1\"", synced_at: new Date().toISOString(), payload: {},
      }],
    });
    // PATCH 204
    fetchMock.mockResolvedValueOnce(okEmpty(204));
    // GET fresh
    fetchMock.mockResolvedValueOnce(ok({
      id: "ms-task-1", title: "Big one", percentComplete: 100, priority: 5,
      completedDateTime: "2026-04-15T12:00:00Z",
      "@odata.etag": "W/\"v2\"",
    }));
    mockQuery.mockResolvedValueOnce({ rows: [{ id: UUID2 }] });
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{
        id: UUID2, user_id: "u", plan_id: UUID, bucket_id: null,
        ms_task_id: "ms-task-1", title: "Big one", due_at: null, start_at: null,
        percent_complete: 100, priority: 5, assignees: ["u", "teammate"],
        created_by: {}, created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: "2026-04-15T12:00:00Z", etag: "W/\"v2\"",
        synced_at: new Date().toISOString(), payload: {},
      }],
    });

    const { completeTask } = await import("@/lib/integrations/microsoft-planner");
    const res = await completeTask("u", "cto", "ms-task-1", "W/\"v1\"");
    expect(res.ok).toBe(true);
    expect(mockTrack).toHaveBeenCalledWith(
      "system.ms_planner_task_completed",
      "u",
      "cto",
      expect.objectContaining({ task_id: "ms-task-1" }),
    );
    // Only the other assignee is notified — not the completer.
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({
      userId: "teammate",
      category: "tasks.completed",
      source: "planner",
      sourceId: "ms-task-1",
    }));
  });
});

// ---------------------------------------------------------------------------
// syncAllForUser — pagination + 429 backoff + 403
// ---------------------------------------------------------------------------

describe("syncAllForUser", () => {
  it("walks groups → plans → buckets → tasks and emits system.ms_planner_synced", async () => {
    // group rows
    mockSafeQuery.mockResolvedValueOnce({ rows: [{ id: "grp-local", ms_group_id: "grp-1" }] });
    // list plans for group
    fetchMock.mockResolvedValueOnce(ok({
      value: [{ id: "plan-1", title: "P1", container: { containerId: "grp-1", type: "group" } }],
    }));
    // upsertPlan
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "plan-local" }] });
    // list buckets
    fetchMock.mockResolvedValueOnce(ok({
      value: [{ id: "buk-1", name: "To Do", orderHint: "1" }],
    }));
    // upsertBucket
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "buk-local" }] });
    // list tasks (first page short → loop exits)
    fetchMock.mockResolvedValueOnce(ok({
      value: [
        { id: "t-1", title: "A", planId: "plan-1", bucketId: "buk-1", percentComplete: 0 },
      ],
    }));
    // resolveBucketIds for upsertTask
    mockSafeQuery.mockResolvedValueOnce({ rows: [{ id: "buk-local", ms_bucket_id: "buk-1" }] });
    // upsertTask
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "t-local" }] });
    // roster plans GET → no roster plans
    fetchMock.mockResolvedValueOnce(ok({ value: [] }));

    const { syncAllForUser } = await import("@/lib/integrations/microsoft-planner");
    const res = await syncAllForUser("u");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error();
    expect(res.value.planCount).toBe(1);
    expect(res.value.bucketCount).toBe(1);
    expect(res.value.taskCount).toBe(1);
    expect(mockTrack).toHaveBeenCalledWith(
      "system.ms_planner_synced",
      "u",
      "system",
      expect.objectContaining({ plan_count: 1, task_count: 1 }),
    );
  });

  it("honors Retry-After on 429 then succeeds", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [{ id: "grp-local", ms_group_id: "grp-1" }] });
    // first: 429, retry: ok
    fetchMock
      .mockResolvedValueOnce(err(429, {}, { "retry-after": "0" }))
      .mockResolvedValueOnce(ok({ value: [] }))
      // roster plans
      .mockResolvedValueOnce(ok({ value: [] }));

    const { syncAllForUser } = await import("@/lib/integrations/microsoft-planner");
    const res = await syncAllForUser("u");
    expect(res.ok).toBe(true);
  });

  it("returns scope_missing on 403 + emits system.ms_planner_sync_failed", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [{ id: "grp-local", ms_group_id: "grp-1" }] });
    fetchMock.mockResolvedValueOnce(err(403, { error: { code: "AccessDenied", message: "nope" } }));

    const { syncAllForUser } = await import("@/lib/integrations/microsoft-planner");
    const res = await syncAllForUser("u");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.code).toBe("scope_missing");
    expect(mockTrack).toHaveBeenCalledWith(
      "system.ms_planner_sync_failed",
      "u",
      "system",
      expect.objectContaining({ code: "scope_missing" }),
    );
  });

  it("returns not_connected when token unavailable + fires sync_failed analytics", async () => {
    mockGetValidToken.mockResolvedValueOnce(null);
    const { syncAllForUser } = await import("@/lib/integrations/microsoft-planner");
    const res = await syncAllForUser("u");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error();
    expect(res.code).toBe("not_connected");
    expect(mockTrack).toHaveBeenCalledWith(
      "system.ms_planner_sync_failed",
      "u",
      "system",
      expect.any(Object),
    );
  });
});
