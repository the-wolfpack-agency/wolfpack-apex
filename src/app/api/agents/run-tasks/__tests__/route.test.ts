/**
 * Contract tests for POST /api/agents/run-tasks: the agent runtime.
 *
 *   - no / invalid agent token -> 401 invalid_token (no claim).
 *   - revoked / paused / missing agent -> 403 agent_not_active (no claim).
 *   - happy path -> drains queued tasks: claim -> runAgentTask -> completeTask,
 *     returns per-task summaries { task_id, status, steps }.
 *   - empty queue -> 200 ran 0.
 *   - per-agent rate limit -> 429 with Retry-After.
 *   - no-store header on every response.
 *   - a thrown runAgentTask for one task does not abort the batch; the task is
 *     recorded failed and the drain continues.
 */

export {};

const mockResolve = jest.fn();
jest.mock("@/lib/agents/identity", () => ({
  resolveAgentFromRequest: (...a: any[]) => mockResolve(...a),
}));

const mockGetAgent = jest.fn();
jest.mock("@/lib/agents/store", () => ({
  getAgent: (...a: any[]) => mockGetAgent(...a),
}));

const mockClaim = jest.fn();
const mockComplete = jest.fn();
jest.mock("@/lib/agents/tasks/store", () => ({
  claimNextQueuedTask: (...a: any[]) => mockClaim(...a),
  completeTask: (...a: any[]) => mockComplete(...a),
}));

const mockRun = jest.fn();
jest.mock("@/lib/agents/tasks/executor", () => ({
  runAgentTask: (...a: any[]) => mockRun(...a),
}));

const PRINCIPAL = {
  agentId: "a_1",
  role: "ops",
  workspaceId: "default",
  ownerUserId: "u_cto",
  provider: "local",
};

function mkReq(auth = "Bearer tok"): any {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return { url: "http://x/api/agents/run-tasks", headers };
}

async function freshRoute() {
  const mod = await import("@/app/api/agents/run-tasks/route");
  mod._resetRateLimit();
  return mod;
}

function task(id: string) {
  return { id, goal: `goal ${id}`, agentId: "a_1", workspaceId: "default" };
}

function runResult(status: string, stepCount: number) {
  const steps = Array.from({ length: stepCount }, (_, i) => ({
    index: i,
    instruction: "x",
    tool: "search",
    outcome: "ran",
    detail: "ok",
  }));
  return { status, steps, resultSummary: `did ${stepCount}` };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResolve.mockResolvedValue(PRINCIPAL);
  mockGetAgent.mockResolvedValue({ id: "a_1", workspaceId: "default", state: "active" });
  mockClaim.mockResolvedValue(null);
  mockRun.mockResolvedValue(runResult("succeeded", 2));
  mockComplete.mockResolvedValue(undefined);
});

describe("POST /api/agents/run-tasks", () => {
  it("401 invalid_token when no agent token resolves; no claim", async () => {
    mockResolve.mockResolvedValue(null);
    const { POST } = await freshRoute();
    const res = await POST(mkReq(""));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_token");
    expect(mockClaim).not.toHaveBeenCalled();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("403 agent_not_active when revoked / paused / missing; no claim", async () => {
    const { POST } = await freshRoute();

    mockGetAgent.mockResolvedValue({ id: "a_1", workspaceId: "default", state: "revoked" });
    let res = await POST(mkReq());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("agent_not_active");

    mockGetAgent.mockResolvedValue({ id: "a_1", workspaceId: "default", state: "paused" });
    res = await POST(mkReq());
    expect(res.status).toBe(403);

    mockGetAgent.mockResolvedValue(null);
    res = await POST(mkReq());
    expect(res.status).toBe(403);

    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("drains queued tasks and returns per-task summaries", async () => {
    mockClaim
      .mockResolvedValueOnce(task("t_1"))
      .mockResolvedValueOnce(task("t_2"))
      .mockResolvedValueOnce(null);
    mockRun
      .mockResolvedValueOnce(runResult("succeeded", 3))
      .mockResolvedValueOnce(runResult("blocked", 1));

    const { POST } = await freshRoute();
    const res = await POST(mkReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      ran: number;
      tasks: Array<{ task_id: string; status: string; steps: number }>;
    };
    expect(body.ok).toBe(true);
    expect(body.ran).toBe(2);
    expect(body.tasks).toEqual([
      { task_id: "t_1", status: "succeeded", steps: 3 },
      { task_id: "t_2", status: "blocked", steps: 1 },
    ]);

    // Each claimed task ran under the agent principal and was persisted.
    expect(mockRun).toHaveBeenNthCalledWith(1, {
      id: "t_1",
      goal: "goal t_1",
      agentId: "a_1",
      role: "ops",
      workspaceId: "default",
      ownerUserId: "u_cto",
    });
    expect(mockComplete).toHaveBeenCalledWith("t_1", "succeeded", expect.any(Array), "did 3");
    expect(mockComplete).toHaveBeenCalledWith("t_2", "blocked", expect.any(Array), "did 1");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns ran 0 when the queue is empty", async () => {
    mockClaim.mockResolvedValue(null);
    const { POST } = await freshRoute();
    const res = await POST(mkReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ran: number; tasks: unknown[] };
    expect(body.ran).toBe(0);
    expect(body.tasks).toEqual([]);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("caps the batch at MAX_RUN even with a deep queue", async () => {
    mockClaim.mockImplementation(async () => task("t"));
    const { POST } = await freshRoute();
    const res = await POST(mkReq());
    const body = (await res.json()) as { ran: number };
    expect(body.ran).toBe(5);
    expect(mockRun).toHaveBeenCalledTimes(5);
  });

  it("a thrown task does not abort the batch; it is recorded failed and the drain continues", async () => {
    mockClaim
      .mockResolvedValueOnce(task("t_bad"))
      .mockResolvedValueOnce(task("t_good"))
      .mockResolvedValueOnce(null);
    mockRun
      .mockRejectedValueOnce(new Error("planner exploded"))
      .mockResolvedValueOnce(runResult("succeeded", 1));

    const { POST } = await freshRoute();
    const res = await POST(mkReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ran: number;
      tasks: Array<{ task_id: string; status: string; steps: number }>;
    };
    expect(body.ran).toBe(2);
    expect(body.tasks[0]).toEqual({ task_id: "t_bad", status: "failed", steps: 0 });
    expect(body.tasks[1]).toEqual({ task_id: "t_good", status: "succeeded", steps: 1 });

    // The failed task was still persisted as failed.
    expect(mockComplete).toHaveBeenCalledWith("t_bad", "failed", [], "Failed during execution.");
  });

  it("429 once the per-agent rate limit is exceeded", async () => {
    const { POST } = await freshRoute();
    let last: any;
    // 6 allowed per window, the 7th trips the limiter.
    for (let i = 0; i < 7; i++) {
      last = await POST(mkReq());
    }
    expect(last.status).toBe(429);
    const body = (await last.json()) as { error: string };
    expect(body.error).toBe("rate_limited");
    expect(last.headers.get("Retry-After")).toBeTruthy();
    expect(last.headers.get("Cache-Control")).toBe("no-store");
  });
});
