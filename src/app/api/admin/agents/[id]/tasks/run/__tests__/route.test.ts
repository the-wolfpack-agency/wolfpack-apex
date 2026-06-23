/**
 * Contract tests for POST /api/admin/agents/[id]/tasks/run (admin backlog drain).
 *
 *   - capability denied -> 401 (requireCapability response returned verbatim).
 *   - unknown agent -> 404 agent_not_found (no claim, no execution).
 *   - paused / revoked agent -> 409 agent_not_active (no claim, no execution).
 *   - happy path -> claims queued tasks and runs each inline as the agent via
 *     executeTaskAsAgent, returns 200 { ran, tasks } (the updated list), and
 *     records the agent.tasks_drained audit.
 *   - empty queue -> 200 ran 0.
 *   - deep queue -> capped at 10 per call.
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

const mockClaim = jest.fn();
const mockListTasksForAgent = jest.fn();
jest.mock("@/lib/agents/tasks/store", () => ({
  claimNextQueuedTask: (...a: any[]) => mockClaim(...a),
  listTasksForAgent: (...a: any[]) => mockListTasksForAgent(...a),
}));

const mockExecute = jest.fn();
jest.mock("@/lib/agents/tasks/run-inline", () => ({
  executeTaskAsAgent: (...a: any[]) => mockExecute(...a),
}));

const mockRecordAudit = jest.fn();
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: any[]) => mockRecordAudit(...a),
  extractRequestMetadata: () => ({ ipAddress: "1.2.3.4", userAgent: "jest" }),
}));

import { POST } from "@/app/api/admin/agents/[id]/tasks/run/route";

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

function mkReq(): any {
  return {
    url: "http://x/api/admin/agents/a_1/tasks/run",
    headers: new Headers(),
    json: async () => ({}),
  };
}

const ctx = { params: Promise.resolve({ id: "a_1" }) };

const ACTIVE_AGENT = {
  id: "a_1",
  workspaceId: "default",
  state: "active",
  role: "ops",
  ownerUserId: "u_owner",
};

function task(id: string) {
  return { id, goal: `goal ${id}`, agentId: "a_1", workspaceId: "default" };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireCapability.mockResolvedValue(okAuth());
  mockGetAgent.mockResolvedValue(ACTIVE_AGENT);
  mockClaim.mockResolvedValue(null);
  mockExecute.mockResolvedValue({ id: "t", status: "succeeded", steps: [] });
  mockListTasksForAgent.mockResolvedValue([{ id: "t_1", status: "succeeded" }]);
  mockRecordAudit.mockResolvedValue(undefined);
});

describe("POST /api/admin/agents/[id]/tasks/run", () => {
  it("returns the requireCapability denial verbatim (401); nothing runs", async () => {
    mockRequireCapability.mockResolvedValue(denied(401));
    const res = await POST(mkReq(), ctx as any);
    expect(res.status).toBe(401);
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("403 when the capability is forbidden", async () => {
    mockRequireCapability.mockResolvedValue(denied(403));
    const res = await POST(mkReq(), ctx as any);
    expect(res.status).toBe(403);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("404 agent_not_found when the agent does not exist; nothing runs", async () => {
    mockGetAgent.mockResolvedValue(null);
    const res = await POST(mkReq(), ctx as any);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("agent_not_found");
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("409 agent_not_active when revoked; nothing runs", async () => {
    mockGetAgent.mockResolvedValue({ ...ACTIVE_AGENT, state: "revoked" });
    const res = await POST(mkReq(), ctx as any);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("agent_not_active");
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("409 agent_not_active when paused; nothing runs", async () => {
    mockGetAgent.mockResolvedValue({ ...ACTIVE_AGENT, state: "paused" });
    const res = await POST(mkReq(), ctx as any);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("agent_not_active");
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("drains the queued tasks inline as the agent and returns the updated list", async () => {
    mockClaim
      .mockResolvedValueOnce(task("t_1"))
      .mockResolvedValueOnce(task("t_2"))
      .mockResolvedValueOnce(null);

    const res = await POST(mkReq(), ctx as any);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ran: number; tasks: unknown[] };
    expect(body.ran).toBe(2);
    expect(body.tasks).toEqual([{ id: "t_1", status: "succeeded" }]);

    // Each claimed task ran inline under the agent's identity.
    const identity = { id: "a_1", role: "ops", ownerUserId: "u_owner", workspaceId: "default" };
    expect(mockExecute).toHaveBeenNthCalledWith(1, identity, { id: "t_1", goal: "goal t_1" });
    expect(mockExecute).toHaveBeenNthCalledWith(2, identity, { id: "t_2", goal: "goal t_2" });

    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { user_id: "u_cto", role: "admin" },
        action: "agent.tasks_drained",
        resourceType: "agent",
        resourceId: "a_1",
        afterState: { agent_id: "a_1", ran: 2 },
      }),
    );
    expect(mockListTasksForAgent).toHaveBeenCalledWith("a_1", "default");
  });

  it("returns ran 0 when the queue is empty", async () => {
    mockClaim.mockResolvedValue(null);
    const res = await POST(mkReq(), ctx as any);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ran: number };
    expect(body.ran).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("caps the drain at 10 even with a deep backlog", async () => {
    mockClaim.mockImplementation(async () => task("t"));
    const res = await POST(mkReq(), ctx as any);
    const body = (await res.json()) as { ran: number };
    expect(body.ran).toBe(10);
    expect(mockExecute).toHaveBeenCalledTimes(10);
  });

  it("still returns 200 when the audit write throws (best-effort)", async () => {
    mockClaim.mockResolvedValueOnce(task("t_1")).mockResolvedValueOnce(null);
    mockRecordAudit.mockRejectedValue(new Error("ledger down"));
    const res = await POST(mkReq(), ctx as any);
    expect(res.status).toBe(200);
  });
});
