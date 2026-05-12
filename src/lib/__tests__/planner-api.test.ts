/**
 * /api/planner/* route tests — plans, buckets, tasks (list/create/update/complete), sync.
 */
 

const mockGetUser = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...args: unknown[]) => mockGetUser(...args),
}));

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrack(...args),
}));

const mockRecordAudit = jest.fn();
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...args: unknown[]) => mockRecordAudit(...args),
}));

const mockListCachedPlans = jest.fn();
const mockListBuckets = jest.fn();
const mockListTasks = jest.fn();
const mockGetTask = jest.fn();
const mockCreateTask = jest.fn();
const mockUpdateTask = jest.fn();
const mockCompleteTask = jest.fn();
const mockSyncAll = jest.fn();
jest.mock("@/lib/integrations/microsoft-planner", () => ({
  listCachedPlans: (...args: unknown[]) => mockListCachedPlans(...args),
  listBuckets: (...args: unknown[]) => mockListBuckets(...args),
  listTasks: (...args: unknown[]) => mockListTasks(...args),
  getTask: (...args: unknown[]) => mockGetTask(...args),
  createTask: (...args: unknown[]) => mockCreateTask(...args),
  updateTask: (...args: unknown[]) => mockUpdateTask(...args),
  completeTask: (...args: unknown[]) => mockCompleteTask(...args),
  syncAllForUser: (...args: unknown[]) => mockSyncAll(...args),
}));

import { GET as plansGET } from "@/app/api/planner/plans/route";
import { GET as bucketsGET } from "@/app/api/planner/plans/[id]/buckets/route";
import { GET as plannerTasksGET } from "@/app/api/planner/plans/[id]/tasks/route";
import { POST as createPOST } from "@/app/api/planner/tasks/route";
import { PATCH as updatePATCH, GET as taskGET } from "@/app/api/planner/tasks/[id]/route";
import { POST as completePOST } from "@/app/api/planner/tasks/[id]/complete/route";
import { POST as syncPOST, _resetRateLimit } from "@/app/api/planner/sync/route";

function mkReq(opts: { auth?: string; body?: unknown; url?: string; method?: string } = {}) {
  const headers = new Headers();
  if (opts.auth) headers.set("authorization", opts.auth);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return new Request(opts.url ?? "http://test/api/planner", {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  }) as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockReturnValue({ id: "u1", role: "cto" });
  mockRecordAudit.mockResolvedValue({ id: "a", seq: 1, entryHash: "h" });
  _resetRateLimit();
});

// ---------------------------------------------------------------------------
// GET /api/planner/plans
// ---------------------------------------------------------------------------

describe("GET /api/planner/plans", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValueOnce(null);
    const res = await plansGET(mkReq());
    expect(res.status).toBe(401);
  });

  it("passes groupId through when query param provided", async () => {
    mockListCachedPlans.mockResolvedValueOnce([{ id: "p1", title: "x" }]);
    const res = await plansGET(mkReq({
      auth: "Bearer x",
      url: "http://test/api/planner/plans?groupId=grp-abc",
    }));
    expect(res.status).toBe(200);
    expect(mockListCachedPlans).toHaveBeenCalledWith("u1", { groupId: "grp-abc" });
    const data = await res.json();
    expect(data.plans).toHaveLength(1);
    expect(mockTrack).toHaveBeenCalledWith(
      "system.page_viewed",
      "u1",
      "cto",
      expect.objectContaining({ endpoint: "planner.plans" }),
    );
  });
});

// ---------------------------------------------------------------------------
// GET /api/planner/plans/[id]/buckets
// ---------------------------------------------------------------------------

describe("GET /api/planner/plans/[id]/buckets", () => {
  it("returns buckets on ok", async () => {
    mockListBuckets.mockResolvedValueOnce({ ok: true, value: [{ id: "b", name: "To Do" }] });
    const res = await bucketsGET(mkReq({ auth: "Bearer x" }), { params: Promise.resolve({ id: "plan-1" }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.buckets).toHaveLength(1);
  });

  it("404 when plan not found", async () => {
    mockListBuckets.mockResolvedValueOnce({ ok: false, code: "not_found" });
    const res = await bucketsGET(mkReq({ auth: "Bearer x" }), { params: Promise.resolve({ id: "plan-x" }) });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/planner/plans/[id]/tasks
// ---------------------------------------------------------------------------

describe("GET /api/planner/plans/[id]/tasks", () => {
  it("accepts filter params + paginates", async () => {
    mockListTasks.mockResolvedValueOnce({ ok: true, value: { tasks: [], nextCursor: null } });
    const res = await plannerTasksGET(
      mkReq({ auth: "Bearer x", url: "http://test/api/planner/plans/plan-1/tasks?percent_complete=100&search=x" }),
      { params: Promise.resolve({ id: "plan-1" }) },
    );
    expect(res.status).toBe(200);
    expect(mockListTasks).toHaveBeenCalledWith(
      "u1",
      "plan-1",
      expect.objectContaining({ percentComplete: 100, search: "x" }),
    );
  });

  it("400 on invalid percent_complete", async () => {
    const res = await plannerTasksGET(
      mkReq({ auth: "Bearer x", url: "http://test/api/planner/plans/plan-1/tasks?percent_complete=abc" }),
      { params: Promise.resolve({ id: "plan-1" }) },
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/planner/tasks (create)
// ---------------------------------------------------------------------------

describe("POST /api/planner/tasks", () => {
  it("400 when planId missing", async () => {
    const res = await createPOST(mkReq({ auth: "Bearer x", body: { title: "X" } }));
    expect(res.status).toBe(400);
  });

  it("400 when title empty", async () => {
    const res = await createPOST(mkReq({ auth: "Bearer x", body: { planId: "p", title: "   " } }));
    expect(res.status).toBe(400);
  });

  it("201 on success", async () => {
    mockCreateTask.mockResolvedValueOnce({
      ok: true, value: { id: "ms-t", task: { id: "t", msTaskId: "ms-t", title: "T" } },
    });
    const res = await createPOST(mkReq({
      auth: "Bearer x", body: { planId: "p", title: "Ship" },
    }));
    expect(res.status).toBe(201);
  });

  it("403 on scope_missing", async () => {
    mockCreateTask.mockResolvedValueOnce({
      ok: false, code: "scope_missing", scope: "Tasks.ReadWrite.Shared",
    });
    const res = await createPOST(mkReq({
      auth: "Bearer x", body: { planId: "p", title: "X" },
    }));
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/planner/tasks/[id]
// ---------------------------------------------------------------------------

describe("PATCH /api/planner/tasks/[id]", () => {
  it("400 when etag missing", async () => {
    const res = await updatePATCH(
      mkReq({ auth: "Bearer x", body: { title: "X" }, method: "PATCH" }),
      { params: Promise.resolve({ id: "t" }) },
    );
    expect(res.status).toBe(400);
  });

  it("409 on etag_conflict", async () => {
    mockUpdateTask.mockResolvedValueOnce({ ok: false, code: "etag_conflict" });
    const res = await updatePATCH(
      mkReq({ auth: "Bearer x", body: { title: "X", etag: "W/\"v1\"" }, method: "PATCH" }),
      { params: Promise.resolve({ id: "t" }) },
    );
    expect(res.status).toBe(409);
  });

  it("200 on success", async () => {
    mockUpdateTask.mockResolvedValueOnce({
      ok: true, value: { id: "ms-t", task: { id: "t", title: "X" } },
    });
    const res = await updatePATCH(
      mkReq({ auth: "Bearer x", body: { title: "X", etag: "W/\"v1\"" }, method: "PATCH" }),
      { params: Promise.resolve({ id: "t" }) },
    );
    expect(res.status).toBe(200);
  });
});

describe("GET /api/planner/tasks/[id]", () => {
  it("404 when task not in cache", async () => {
    mockGetTask.mockResolvedValueOnce(null);
    const res = await taskGET(
      mkReq({ auth: "Bearer x" }),
      { params: Promise.resolve({ id: "t" }) },
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/planner/tasks/[id]/complete
// ---------------------------------------------------------------------------

describe("POST /api/planner/tasks/[id]/complete", () => {
  it("400 when etag missing", async () => {
    const res = await completePOST(
      mkReq({ auth: "Bearer x", body: {} }),
      { params: Promise.resolve({ id: "t" }) },
    );
    expect(res.status).toBe(400);
  });

  it("200 on success", async () => {
    mockCompleteTask.mockResolvedValueOnce({
      ok: true, value: { id: "ms-t", task: { id: "t", title: "X" } },
    });
    const res = await completePOST(
      mkReq({ auth: "Bearer x", body: { etag: "W/\"v1\"" } }),
      { params: Promise.resolve({ id: "t" }) },
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /api/planner/sync
// ---------------------------------------------------------------------------

describe("POST /api/planner/sync", () => {
  it("records audit on success", async () => {
    mockSyncAll.mockResolvedValueOnce({
      ok: true, value: { planCount: 2, bucketCount: 4, taskCount: 10, durationMs: 200 },
    });
    const res = await syncPOST(mkReq({ auth: "Bearer x", method: "POST" }));
    expect(res.status).toBe(200);
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "planner.synced",
      resourceType: "planner",
    }));
  });

  it("429 within rate-limit window", async () => {
    mockSyncAll.mockResolvedValue({
      ok: true, value: { planCount: 0, bucketCount: 0, taskCount: 0, durationMs: 0 },
    });
    await syncPOST(mkReq({ auth: "Bearer x", method: "POST" }));
    const second = await syncPOST(mkReq({ auth: "Bearer x", method: "POST" }));
    expect(second.status).toBe(429);
  });

  it("403 on scope_missing", async () => {
    mockSyncAll.mockResolvedValueOnce({
      ok: false, code: "scope_missing", scope: "Tasks.ReadWrite.Shared",
    });
    const res = await syncPOST(mkReq({ auth: "Bearer x", method: "POST" }));
    expect(res.status).toBe(403);
  });
});
