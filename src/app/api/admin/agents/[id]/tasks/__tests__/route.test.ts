/**
 * Contract tests for /api/admin/agents/[id]/tasks (human task assignment).
 *
 *   POST:
 *     - capability denied -> 401 (requireCapability response is returned verbatim).
 *     - unknown agent -> 404 agent_not_found (no createTask).
 *     - revoked agent -> 409 agent_revoked (no createTask).
 *     - empty / oversized goal -> 400 (no createTask).
 *     - happy path -> 201 { task }, createTask called with the resolved actor,
 *       recordAudit fired with agent.task_assigned.
 *   GET:
 *     - 200 { tasks } shape from listTasksForAgent.
 */

export {};

const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCapability(...a),
}));

const mockGetAgent = jest.fn();
jest.mock("@/lib/agents/store", () => ({
  getAgent: (...a: any[]) => mockGetAgent(...a),
}));

const mockCreateTask = jest.fn();
const mockListTasksForAgent = jest.fn();
jest.mock("@/lib/agents/tasks/store", () => ({
  createTask: (...a: any[]) => mockCreateTask(...a),
  listTasksForAgent: (...a: any[]) => mockListTasksForAgent(...a),
}));

const mockRecordAudit = jest.fn();
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: any[]) => mockRecordAudit(...a),
  extractRequestMetadata: () => ({ ipAddress: "1.2.3.4", userAgent: "jest" }),
}));

import { POST, GET } from "@/app/api/admin/agents/[id]/tasks/route";

const USER = { id: "u_cto", role: "admin", workspaceId: "default" };

function okAuth() {
  return { ok: true, user: USER, capabilities: new Set() };
}

function denied(status: number) {
  return {
    ok: false,
    response: {
      status,
      json: async () => ({ error: status === 401 ? "unauthorized" : "forbidden" }),
    },
  };
}

function mkReq(body: unknown): any {
  return {
    url: "http://x/api/admin/agents/a_1/tasks",
    headers: new Headers(),
    json: async () => body,
  };
}

const ctx = { params: Promise.resolve({ id: "a_1" }) };

const TASK = {
  id: "t_1",
  agentId: "a_1",
  workspaceId: "default",
  assignedBy: "u_cto",
  goal: "draft the brief",
  status: "queued",
  steps: [],
  resultSummary: null,
  createdAt: "2026-06-23T00:00:00Z",
  startedAt: null,
  finishedAt: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireCapability.mockResolvedValue(okAuth());
  mockGetAgent.mockResolvedValue({ id: "a_1", workspaceId: "default", state: "active" });
  mockCreateTask.mockResolvedValue(TASK);
  mockListTasksForAgent.mockResolvedValue([TASK]);
  mockRecordAudit.mockResolvedValue(undefined);
});

describe("POST /api/admin/agents/[id]/tasks", () => {
  it("returns the requireCapability denial verbatim (401)", async () => {
    mockRequireCapability.mockResolvedValue(denied(401));
    const res = await POST(mkReq({ goal: "x" }), ctx as any);
    expect(res.status).toBe(401);
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it("returns 403 when capability is forbidden", async () => {
    mockRequireCapability.mockResolvedValue(denied(403));
    const res = await POST(mkReq({ goal: "x" }), ctx as any);
    expect(res.status).toBe(403);
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it("404 agent_not_found when the agent does not exist", async () => {
    mockGetAgent.mockResolvedValue(null);
    const res = await POST(mkReq({ goal: "x" }), ctx as any);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("agent_not_found");
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it("409 agent_revoked when the agent is revoked", async () => {
    mockGetAgent.mockResolvedValue({ id: "a_1", workspaceId: "default", state: "revoked" });
    const res = await POST(mkReq({ goal: "x" }), ctx as any);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("agent_revoked");
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it("400 when goal is empty / whitespace", async () => {
    const res = await POST(mkReq({ goal: "   " }), ctx as any);
    expect(res.status).toBe(400);
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it("400 when goal exceeds 4000 chars", async () => {
    const res = await POST(mkReq({ goal: "x".repeat(4001) }), ctx as any);
    expect(res.status).toBe(400);
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it("201 creates the task with the resolved actor and fires the audit", async () => {
    const res = await POST(mkReq({ goal: "  draft the brief  " }), ctx as any);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { task: { id: string } };
    expect(body.task.id).toBe("t_1");

    expect(mockCreateTask).toHaveBeenCalledWith({
      agentId: "a_1",
      workspaceId: "default",
      assignedBy: "u_cto",
      assignedByRole: "admin",
      goal: "draft the brief", // trimmed
    });

    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { user_id: "u_cto", role: "admin" },
        action: "agent.task_assigned",
        resourceType: "agent_task",
        resourceId: "t_1",
        afterState: { agent_id: "a_1" },
      }),
    );
  });

  it("still returns 201 when the audit write throws (best-effort)", async () => {
    mockRecordAudit.mockRejectedValue(new Error("ledger down"));
    const res = await POST(mkReq({ goal: "draft" }), ctx as any);
    expect(res.status).toBe(201);
  });
});

describe("GET /api/admin/agents/[id]/tasks", () => {
  it("401 when capability is denied", async () => {
    mockRequireCapability.mockResolvedValue(denied(401));
    const res = await GET(mkReq(null), ctx as any);
    expect(res.status).toBe(401);
    expect(mockListTasksForAgent).not.toHaveBeenCalled();
  });

  it("200 returns the task list", async () => {
    const res = await GET(mkReq(null), ctx as any);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: Array<{ id: string }> };
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].id).toBe("t_1");
    expect(mockListTasksForAgent).toHaveBeenCalledWith("a_1", "default");
  });
});
