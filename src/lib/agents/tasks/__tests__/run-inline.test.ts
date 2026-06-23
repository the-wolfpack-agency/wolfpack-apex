/**
 * Unit tests for executeTaskAsAgent: the single source of truth for "run one
 * task as the agent and persist the outcome."
 *
 *   - success: runs the governed executor under the AGENT identity, persists the
 *     run result via completeTask, and returns the refreshed task row.
 *   - thrown executor: best-effort marks the task failed and still returns the
 *     refreshed row, never throwing into the caller.
 *
 * The executor and the store are mocked so this is deterministic and DB-free.
 * The executor itself owns analytics/learning (agent.task_completed), so this
 * helper never fires it directly and we assert it is not imported as analytics
 * here.
 */

export {};

const mockRun = jest.fn();
jest.mock("@/lib/agents/tasks/executor", () => ({
  runAgentTask: (...a: any[]) => mockRun(...a),
}));

const mockComplete = jest.fn();
const mockGetTask = jest.fn();
jest.mock("@/lib/agents/tasks/store", () => ({
  completeTask: (...a: any[]) => mockComplete(...a),
  getTask: (...a: any[]) => mockGetTask(...a),
}));

import { executeTaskAsAgent } from "@/lib/agents/tasks/run-inline";

const AGENT = {
  id: "a_1",
  role: "ops",
  ownerUserId: "u_cto",
  workspaceId: "default",
};

const TASK = { id: "t_1", goal: "draft the brief" };

function steps(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    instruction: "x",
    tool: "search",
    outcome: "ran",
    detail: "ok",
  }));
}

function refreshed(status: string, n: number) {
  return {
    id: "t_1",
    agentId: "a_1",
    workspaceId: "default",
    assignedBy: "u_cto",
    goal: "draft the brief",
    status,
    steps: steps(n),
    resultSummary: `did ${n}`,
    createdAt: "2026-06-23T00:00:00Z",
    startedAt: "2026-06-23T00:00:00Z",
    finishedAt: "2026-06-23T00:00:01Z",
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("executeTaskAsAgent", () => {
  it("runs the executor as the agent, persists the result, returns the refreshed task", async () => {
    mockRun.mockResolvedValue({
      status: "succeeded",
      steps: steps(3),
      resultSummary: "did 3",
      inherited: false,
    });
    mockGetTask.mockResolvedValue(refreshed("succeeded", 3));

    const out = await executeTaskAsAgent(AGENT, TASK);

    // The executor ran under the agent's own identity.
    expect(mockRun).toHaveBeenCalledWith(
      {
        id: "t_1",
        goal: "draft the brief",
        agentId: "a_1",
        role: "ops",
        workspaceId: "default",
        ownerUserId: "u_cto",
      },
      undefined,
    );
    // The run result was persisted.
    expect(mockComplete).toHaveBeenCalledWith("t_1", "succeeded", steps(3), "did 3");
    // The refreshed row is returned.
    expect(out?.status).toBe("succeeded");
    expect(out?.steps).toHaveLength(3);
    expect(mockGetTask).toHaveBeenCalledWith("t_1", "default");
  });

  it("passes an explicit executor deps through for deterministic tests", async () => {
    mockRun.mockResolvedValue({
      status: "succeeded",
      steps: [],
      resultSummary: "done",
      inherited: false,
    });
    mockGetTask.mockResolvedValue(refreshed("succeeded", 0));
    const deps = { dispatch: jest.fn() } as any;

    await executeTaskAsAgent(AGENT, TASK, deps);

    expect(mockRun).toHaveBeenCalledWith(expect.objectContaining({ id: "t_1" }), deps);
  });

  it("surfaces a blocked run as a blocked persisted task", async () => {
    mockRun.mockResolvedValue({
      status: "blocked",
      steps: steps(1),
      resultSummary: "Stopped for approval after 1 step(s).",
      inherited: false,
    });
    mockGetTask.mockResolvedValue(refreshed("blocked", 1));

    const out = await executeTaskAsAgent(AGENT, TASK);

    expect(mockComplete).toHaveBeenCalledWith(
      "t_1",
      "blocked",
      steps(1),
      "Stopped for approval after 1 step(s).",
    );
    expect(out?.status).toBe("blocked");
  });

  it("marks the task failed and still returns it when the executor throws", async () => {
    mockRun.mockRejectedValue(new Error("planner exploded"));
    mockGetTask.mockResolvedValue(refreshed("failed", 0));

    const out = await executeTaskAsAgent(AGENT, TASK);

    // Best-effort failure persistence, never throwing into the caller.
    expect(mockComplete).toHaveBeenCalledWith("t_1", "failed", [], "Failed during execution.");
    expect(out?.status).toBe("failed");
  });

  it("does not throw when the failure-marking write also throws", async () => {
    mockRun.mockRejectedValue(new Error("planner exploded"));
    mockComplete.mockRejectedValueOnce(new Error("db down"));
    mockGetTask.mockResolvedValue(null);

    await expect(executeTaskAsAgent(AGENT, TASK)).resolves.toBeNull();
  });
});
