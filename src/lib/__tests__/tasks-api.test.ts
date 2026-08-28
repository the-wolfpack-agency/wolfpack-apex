/**
 * /api/tasks route tests — auth gate, validation, rate limit, analytics,
 * webhook signature validation.
 */
 

const mockGetUser = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...args: unknown[]) => mockGetUser(...args),
}));

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrack(...args),
}));

const mockListCached = jest.fn();
const mockListLive = jest.fn();
const mockCreateTask = jest.fn();
const mockUpdateTask = jest.fn();
const mockCompleteTask = jest.fn();
const mockGetCachedById = jest.fn();
const mockSyncAll = jest.fn();
const mockListCachedLists = jest.fn();
const mockResolveDefault = jest.fn();
const mockVerifyWebhook = jest.fn();

class FakeGraphError extends Error {
  status: number;
  retryAfter?: number;
  constructor(status: number, msg: string, retryAfter?: number) {
    super(msg);
    this.name = "GraphTasksError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

jest.mock("@/lib/integrations/microsoft-tasks", () => ({
  // The Outlook-field validator is a pure guard the routes call before
  // delegating — use the real implementation so validation is exercised.
  validateOutlookTaskFields: jest.requireActual(
    "@/lib/integrations/microsoft-tasks",
  ).validateOutlookTaskFields,
  listCachedTasks: (...args: unknown[]) => mockListCached(...args),
  listOpenTasksLive: (...args: unknown[]) => mockListLive(...args),
  createTask: (...args: unknown[]) => mockCreateTask(...args),
  updateTask: (...args: unknown[]) => mockUpdateTask(...args),
  completeTask: (...args: unknown[]) => mockCompleteTask(...args),
  getCachedTaskById: (...args: unknown[]) => mockGetCachedById(...args),
  syncAllForUser: (...args: unknown[]) => mockSyncAll(...args),
  listCachedTaskLists: (...args: unknown[]) => mockListCachedLists(...args),
  resolveDefaultListId: (...args: unknown[]) => mockResolveDefault(...args),
  verifyWebhookClientState: (...args: unknown[]) => mockVerifyWebhook(...args),
  GraphTasksError: FakeGraphError,
}));

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...args: unknown[]) => mockSafeQuery(...args),
  query: jest.fn(),
}));

import { GET as tasksGET, POST as tasksPOST } from "@/app/api/tasks/route";
import { GET as listsGET } from "@/app/api/tasks/lists/route";
import { PATCH as taskPATCH, GET as taskGET } from "@/app/api/tasks/[id]/route";
import { POST as completePOST } from "@/app/api/tasks/[id]/complete/route";
import { POST as syncPOST, _resetRateLimit } from "@/app/api/tasks/sync/route";
import { POST as webhookPOST } from "@/app/api/tasks/webhook/route";

function mkReq(opts: {
  auth?: string; body?: unknown; url?: string; method?: string; headers?: Record<string, string>;
} = {}) {
  const headers = new Headers(opts.headers ?? {});
  if (opts.auth) headers.set("authorization", opts.auth);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return new Request(opts.url ?? "http://test/api/tasks", {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  }) as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimit();
  mockResolveDefault.mockResolvedValue("default-list");
  mockListLive.mockResolvedValue({ ok: true, tasks: [] });
});

// ---------------------------------------------------------------------------
// GET /api/tasks
// ---------------------------------------------------------------------------

describe("GET /api/tasks", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await tasksGET(mkReq());
    expect(res.status).toBe(401);
  });

  /* THE PLAIN READ GOES TO MICROSOFT NOW. instinct_ms_tasks has never held a
     row in production and nothing schedules the sync that would fill it, so
     this path returned nothing to everybody. This test named the cache because
     the cache was all there was. */
  it("returns tasks read live from Microsoft", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockListLive.mockResolvedValue({ ok: true, tasks: [{ id: "t1" }] });
    const res = await tasksGET(mkReq({ auth: "Bearer x", url: "http://test/api/tasks?limit=10" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tasks).toHaveLength(1);
    expect(data.source).toBe("live");
    expect(mockListCached).not.toHaveBeenCalled();
  });

  /* A named reason rather than an empty list, because "not connected" and
     "you have no tasks" are different sentences and the page draws them
     differently. */
  it("reports why it could not read rather than returning an empty list", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockListLive.mockResolvedValue({ ok: false, reason: "scope_missing" });
    const res = await tasksGET(mkReq({ auth: "Bearer x", url: "http://test/api/tasks" }));
    const data = await res.json();
    expect(data.tasks).toEqual([]);
    expect(data.unavailableReason).toBe("scope_missing");
    expect(data.everSynced).toBe(false);
  });

  /* A FILTERED REQUEST STILL USES THE MIRROR, deliberately. Graph has no
     cursor over a filtered union of lists, and answering a filtered request
     with an unfiltered live list would be a worse bug than answering from what
     the mirror has. */
  it("uses the mirror for a filtered request, and says so", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockListCached.mockResolvedValue({ tasks: [{ id: "t1" }], nextCursor: "t1" });
    const res = await tasksGET(
      mkReq({ auth: "Bearer x", url: "http://test/api/tasks?status=notStarted" }),
    );
    const data = await res.json();
    expect(data.nextCursor).toBe("t1");
    expect(data.source).toBe("mirror");
    expect(mockListLive).not.toHaveBeenCalled();
  });

  it("400 on invalid status param", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    const res = await tasksGET(mkReq({ auth: "Bearer x", url: "http://test/api/tasks?status=bogus" }));
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/tasks
// ---------------------------------------------------------------------------

describe("POST /api/tasks", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await tasksPOST(mkReq({ body: { listId: "l", title: "t" } }));
    expect(res.status).toBe(401);
  });

  it("201 defaults to the user's default To Do list when listId is missing", async () => {
    // The list is optional: a task can be created with just a title. The route
    // resolves the user's default list server-side.
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockCreateTask.mockResolvedValue({ id: "task-uuid", msTaskId: "ms-1", title: "t" });
    const res = await tasksPOST(mkReq({ auth: "Bearer x", body: { title: "t" } }));
    expect(res.status).toBe(201);
    expect(mockResolveDefault).toHaveBeenCalledWith("u");
    expect(mockCreateTask).toHaveBeenCalledWith("u", "default-list", expect.objectContaining({ title: "t" }));
  });

  it("honors an explicit listId without resolving the default", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockCreateTask.mockResolvedValue({ id: "task-uuid", msTaskId: "ms-1", title: "t" });
    const res = await tasksPOST(mkReq({ auth: "Bearer x", body: { listId: "l", title: "t" } }));
    expect(res.status).toBe(201);
    expect(mockResolveDefault).not.toHaveBeenCalled();
    expect(mockCreateTask).toHaveBeenCalledWith("u", "l", expect.objectContaining({ title: "t" }));
  });

  it("400 when title missing", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    const res = await tasksPOST(mkReq({ auth: "Bearer x", body: { listId: "l" } }));
    expect(res.status).toBe(400);
  });

  it("201 on success", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockCreateTask.mockResolvedValue({ id: "task-uuid", msTaskId: "ms-1", title: "Write memo" });
    const res = await tasksPOST(mkReq({ auth: "Bearer x", body: { listId: "l", title: "Write memo" } }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.task.msTaskId).toBe("ms-1");
  });

  it("429 on Graph rate limit with Retry-After", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockCreateTask.mockRejectedValue(new FakeGraphError(429, "rate", 30));
    const res = await tasksPOST(mkReq({ auth: "Bearer x", body: { listId: "l", title: "x" } }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
  });
});

// ---------------------------------------------------------------------------
// GET /api/tasks/lists
// ---------------------------------------------------------------------------

describe("GET /api/tasks/lists", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await listsGET(mkReq());
    expect(res.status).toBe(401);
  });

  it("returns cached lists", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockListCachedLists.mockResolvedValue([{ id: "l-uuid", displayName: "Tasks" }]);
    const res = await listsGET(mkReq({ auth: "Bearer x", url: "http://test/api/tasks/lists" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.lists).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// GET + PATCH /api/tasks/[id]
// ---------------------------------------------------------------------------

describe("GET /api/tasks/[id]", () => {
  it("emits system.task_viewed on success", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockGetCachedById.mockResolvedValue({ id: "t-uuid", msTaskId: "ms-1", listId: "list-uuid" });
    const res = await taskGET(mkReq({ auth: "Bearer x" }), { params: Promise.resolve({ id: "t-uuid" }) });
    expect(res.status).toBe(200);
    expect(mockTrack).toHaveBeenCalledWith(
      "system.task_viewed",
      "u",
      "cto",
      expect.objectContaining({ task_id: "ms-1" }),
    );
  });

  it("404 when not found", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockGetCachedById.mockResolvedValue(null);
    const res = await taskGET(mkReq({ auth: "Bearer x" }), { params: Promise.resolve({ id: "no" }) });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/tasks/[id]", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await taskPATCH(mkReq({ body: {} }), { params: Promise.resolve({ id: "t" }) });
    expect(res.status).toBe(401);
  });

  it("400 on invalid status", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockGetCachedById.mockResolvedValue({ id: "t", msTaskId: "ms-1", listId: "list-uuid" });
    const res = await taskPATCH(
      mkReq({ auth: "Bearer x", body: { status: "bogus" } }),
      { params: Promise.resolve({ id: "t" }) },
    );
    expect(res.status).toBe(400);
  });

  it("200 on success", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockGetCachedById.mockResolvedValue({ id: "t", msTaskId: "ms-1", listId: "list-uuid" });
    mockSafeQuery.mockResolvedValue({ rows: [{ ms_list_id: "ms-list-1" }] });
    mockUpdateTask.mockResolvedValue({ id: "t", msTaskId: "ms-1", title: "new" });
    const res = await taskPATCH(
      mkReq({ auth: "Bearer x", body: { title: "new" } }),
      { params: Promise.resolve({ id: "t" }) },
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /api/tasks/[id]/complete
// ---------------------------------------------------------------------------

describe("POST /api/tasks/[id]/complete", () => {
  it("200 + completeTask called with resolved ms_list_id", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockGetCachedById.mockResolvedValue({ id: "t", msTaskId: "ms-1", listId: "list-uuid" });
    mockSafeQuery.mockResolvedValue({ rows: [{ ms_list_id: "ms-list-1" }] });
    mockCompleteTask.mockResolvedValue({ id: "t", msTaskId: "ms-1", status: "completed" });
    const res = await completePOST(mkReq({ auth: "Bearer x" }), { params: Promise.resolve({ id: "t" }) });
    expect(res.status).toBe(200);
    expect(mockCompleteTask).toHaveBeenCalledWith("u", "ms-list-1", "ms-1", "instinct");
  });

  it("404 when task not cached", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockGetCachedById.mockResolvedValue(null);
    const res = await completePOST(mkReq({ auth: "Bearer x" }), { params: Promise.resolve({ id: "t" }) });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/tasks/sync — rate limit + happy path
// ---------------------------------------------------------------------------

describe("POST /api/tasks/sync", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await syncPOST(mkReq({ method: "POST" }));
    expect(res.status).toBe(401);
  });

  it("200 on first call, 429 on second (1/min)", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "cto" });
    mockSyncAll.mockResolvedValue({ listCount: 1, taskCount: 3, durationMs: 42 });
    const r1 = await syncPOST(mkReq({ auth: "Bearer x", method: "POST" }));
    expect(r1.status).toBe(200);
    const r2 = await syncPOST(mkReq({ auth: "Bearer x", method: "POST" }));
    expect(r2.status).toBe(429);
    expect(r2.headers.get("retry-after")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// POST /api/tasks/webhook
// ---------------------------------------------------------------------------

describe("POST /api/tasks/webhook", () => {
  it("handles validationToken handshake", async () => {
    const res = await webhookPOST(mkReq({
      url: "http://test/api/tasks/webhook?validationToken=xyz",
      method: "POST",
      body: {},
    }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("xyz");
  });

  it("401 when clientState fails", async () => {
    mockVerifyWebhook.mockReturnValue(false);
    const res = await webhookPOST(mkReq({
      method: "POST",
      body: { value: [{ clientState: "bad", resource: "users/x/todo/lists/l/tasks/t" }] },
    }));
    expect(res.status).toBe(401);
  });

  it("202 + enqueues sync on valid notification", async () => {
    mockVerifyWebhook.mockReturnValue(true);
    mockSafeQuery.mockResolvedValue({ rows: [{ connected_by: "user-123" }] });
    mockSyncAll.mockResolvedValue({ listCount: 1, taskCount: 1, durationMs: 10 });
    const res = await webhookPOST(mkReq({
      method: "POST",
      body: { value: [{ clientState: "ok", resource: "users/u@example.com/todo/lists/l/tasks/t" }] },
    }));
    expect(res.status).toBe(202);
    // The sync is fire-and-forget — flush the microtask queue.
    await new Promise((r) => setImmediate(r));
    expect(mockSyncAll).toHaveBeenCalledWith("user-123");
  });

  it("400 on invalid JSON body", async () => {
    const req = new Request("http://test/api/tasks/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    }) as any;
    const res = await webhookPOST(req);
    expect(res.status).toBe(400);
  });
});
