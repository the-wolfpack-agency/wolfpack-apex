/**
 * delegate_to_agent: the capstone "human directs an onboarded agent to do
 * real work" tool.
 *
 * Coverage:
 *   - INTENT_RE: claims explicit agent-direction phrasings and ONLY those.
 *   - happy path: owner directs an active agent; createTask + runAgentTask +
 *     completeTask wire through; agent.delegated fires; answer reflects the
 *     succeeded outcome with the per-step list.
 *   - blocked path: the executor returns "blocked"; the answer explains the
 *     OGIAM escalation to the owner; completeTask + analytics still fire.
 *   - authorization: a non-owner non-manager user is refused and createTask is
 *     NEVER called (the security boundary that stops weaponizing an agent).
 *   - unknown agent name lists available names.
 *   - a paused agent is refused with the state message.
 */

const mockListAgents = jest.fn();
const mockGetAgent = jest.fn();
const mockCreateTask = jest.fn();
const mockCompleteTask = jest.fn();
const mockRunAgentTask = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/agents/store", () => ({
  listAgents: (...a: unknown[]) => mockListAgents(...a),
  getAgent: (...a: unknown[]) => mockGetAgent(...a),
}));
jest.mock("@/lib/agents/tasks/store", () => ({
  createTask: (...a: unknown[]) => mockCreateTask(...a),
  completeTask: (...a: unknown[]) => mockCompleteTask(...a),
}));
jest.mock("@/lib/agents/tasks/executor", () => ({
  runAgentTask: (...a: unknown[]) => mockRunAgentTask(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import {
  delegateToAgentTool,
  matchDelegateIntent,
} from "@/lib/assistant/tools/delegate-to-agent-tool";

const AGENT = {
  id: "agent-1",
  workspaceId: "ws-1",
  name: "Agent1",
  role: "ops",
  ownerUserId: "owner-1",
  state: "active" as const,
  identityProvider: "local" as const,
  externalSubject: null,
  scanStatus: "complete" as const,
  description: null,
  createdBy: "owner-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  activatedAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: null,
  revokedAt: null,
};

const OWNER_CTX = {
  userId: "owner-1",
  userRole: "ops",
  workspaceId: "ws-1",
  workflowId: "wf-1",
};

function succeededRun() {
  return {
    status: "succeeded" as const,
    steps: [
      { index: 0, instruction: "add a task titled Doctors Appointment", tool: "create_task_form", outcome: "ran" as const, detail: "task created" },
    ],
    resultSummary: "Completed 1 of 1 step(s).",
    inherited: false,
  };
}

beforeEach(() => {
  mockListAgents.mockReset();
  mockGetAgent.mockReset();
  mockCreateTask.mockReset();
  mockCompleteTask.mockReset();
  mockRunAgentTask.mockReset();
  mockTrackEvent.mockReset();
});

describe("delegate_to_agent intent matching", () => {
  test.each([
    ["Agent1 add a task titled Doctors Appointment", "Agent1", "add a task titled Doctors Appointment"],
    ["Agent 1 add a task titled Doctors Appointment", "Agent 1", "add a task titled Doctors Appointment"],
    ["tell Scout to log my hours", "Scout", "log my hours"],
    ["ask Scout to draft the report", "Scout", "draft the report"],
    ["have Scout to file the invoice", "Scout", "file the invoice"],
    ["direct Scout to update the deal", "Scout", "update the deal"],
    ["ask Agent1 to log my hours", "Agent1", "log my hours"],
    ["@Scout draft the report", "Scout", "draft the report"],
  ])("claims '%s'", (msg, name, instruction) => {
    const parsed = matchDelegateIntent(msg);
    expect(parsed).not.toBeNull();
    expect(parsed!.agentName).toBe(name);
    expect(parsed!.instruction).toBe(instruction);
  });

  test.each([
    "add a task titled Doctors Appointment",
    "search Acme",
    "look up Acme",
    "who is Nick Homyk",
    "create a task",
    "tell me a joke",
  ])("does NOT claim '%s'", (msg) => {
    expect(matchDelegateIntent(msg)).toBeNull();
  });

  test("the tool's matchIntent is wired to the same matcher", () => {
    expect(
      delegateToAgentTool.matchIntent("Agent1 add a task titled X"),
    ).not.toBeNull();
    expect(delegateToAgentTool.matchIntent("add a task titled X")).toBeNull();
  });
});

describe("delegate_to_agent handler", () => {
  test("happy path: owner directs an active agent -> succeeded", async () => {
    mockListAgents.mockResolvedValue([AGENT]);
    mockCreateTask.mockResolvedValue({ id: "task-1" });
    const run = succeededRun();
    mockRunAgentTask.mockResolvedValue(run);

    const params = matchDelegateIntent(
      "Agent1 add a task titled Doctors Appointment",
    )!;
    const res = await delegateToAgentTool.handler(params, OWNER_CTX);

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // createTask got the parsed instruction + requester identity/role.
    expect(mockCreateTask).toHaveBeenCalledWith({
      agentId: "agent-1",
      workspaceId: "ws-1",
      assignedBy: "owner-1",
      assignedByRole: "ops",
      goal: "add a task titled Doctors Appointment",
    });

    // runAgentTask ran AS the agent: the agent's role + owner, not the human's.
    expect(mockRunAgentTask).toHaveBeenCalledWith({
      id: "task-1",
      goal: "add a task titled Doctors Appointment",
      agentId: "agent-1",
      role: "ops",
      workspaceId: "ws-1",
      ownerUserId: "owner-1",
    });

    // completeTask persisted the run result.
    expect(mockCompleteTask).toHaveBeenCalledWith(
      "task-1",
      "succeeded",
      run.steps,
      run.resultSummary,
    );

    // analytics: agent.delegated fired with the outcome.
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "agent.delegated",
      "agent-1",
      "agent",
      expect.objectContaining({
        workspace_id: "ws-1",
        requested_by: "owner-1",
        requester_role: "ops",
        status: "succeeded",
        steps: 1,
        inherited: false,
      }),
    );

    expect(res.answer).toContain("Agent1 completed");
    expect(res.answer).toContain("Completed 1 of 1 step(s).");
    expect(res.answer).toContain("add a task titled Doctors Appointment -> ran");
    expect(res.data.status).toBe("succeeded");
    expect(res.data.taskId).toBe("task-1");
    expect(res.data.agentId).toBe("agent-1");
  });

  test("blocked path: explains the OGIAM escalation, still completes + tracks", async () => {
    mockListAgents.mockResolvedValue([AGENT]);
    mockCreateTask.mockResolvedValue({ id: "task-2" });
    const run = {
      status: "blocked" as const,
      steps: [
        { index: 0, instruction: "approve the wire transfer", tool: "send_wire", outcome: "blocked" as const, detail: "OGIAM held this step" },
      ],
      resultSummary: "Stopped for approval after 0 step(s).",
      inherited: false,
    };
    mockRunAgentTask.mockResolvedValue(run);

    const params = matchDelegateIntent("Agent1 approve the wire transfer")!;
    const res = await delegateToAgentTool.handler(params, OWNER_CTX);

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(mockCompleteTask).toHaveBeenCalledWith(
      "task-2",
      "blocked",
      run.steps,
      run.resultSummary,
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "agent.delegated",
      "agent-1",
      "agent",
      expect.objectContaining({ status: "blocked" }),
    );

    expect(res.answer).toMatch(/OGIAM/);
    expect(res.answer).toMatch(/owner/i);
    expect(res.answer).toContain("approve the wire transfer");
    expect(res.data.status).toBe("blocked");
  });

  test("authorization: a non-owner non-manager user is refused and createTask is NOT called", async () => {
    mockListAgents.mockResolvedValue([AGENT]);

    const lowPrivCtx = {
      userId: "intruder-1",
      userRole: "sales", // below manager, and not the owner
      workspaceId: "ws-1",
    };
    const params = matchDelegateIntent("Agent1 add a task titled X")!;
    const res = await delegateToAgentTool.handler(params, lowPrivCtx);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("capability");
    expect(res.message).toMatch(/owner|manager/i);

    // The security boundary: nothing was created, run, or tracked.
    expect(mockCreateTask).not.toHaveBeenCalled();
    expect(mockRunAgentTask).not.toHaveBeenCalled();
    expect(mockCompleteTask).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  test("authorization: a manager who is NOT the owner is allowed", async () => {
    mockListAgents.mockResolvedValue([AGENT]);
    mockCreateTask.mockResolvedValue({ id: "task-3" });
    mockRunAgentTask.mockResolvedValue(succeededRun());

    const managerCtx = {
      userId: "manager-9",
      userRole: "manager",
      workspaceId: "ws-1",
    };
    const params = matchDelegateIntent("Agent1 add a task titled X")!;
    const res = await delegateToAgentTool.handler(params, managerCtx);

    expect(res.ok).toBe(true);
    expect(mockCreateTask).toHaveBeenCalled();
  });

  test("unknown agent name -> not_found listing available names", async () => {
    mockListAgents.mockResolvedValue([
      { ...AGENT, name: "Scout" },
      { ...AGENT, id: "agent-2", name: "Ranger" },
    ]);

    const params = matchDelegateIntent("Agent1 add a task titled X")!;
    const res = await delegateToAgentTool.handler(params, OWNER_CTX);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("no_match");
    expect(res.message).toContain("Scout");
    expect(res.message).toContain("Ranger");
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  test("paused agent -> refused with the state message", async () => {
    mockListAgents.mockResolvedValue([{ ...AGENT, state: "paused" }]);

    const params = matchDelegateIntent("Agent1 add a task titled X")!;
    const res = await delegateToAgentTool.handler(params, OWNER_CTX);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("capability");
    expect(res.message).toMatch(/paused/);
    expect(res.message).toContain("/admin/agents/agent-1");
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  test("no workspace in context -> capability failure", async () => {
    const params = matchDelegateIntent("Agent1 add a task titled X")!;
    const res = await delegateToAgentTool.handler(params, {
      userId: "owner-1",
      userRole: "ops",
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("capability");
    expect(res.message).toBe("No workspace in context.");
    expect(mockListAgents).not.toHaveBeenCalled();
  });

  test("workspace falls back to agentPrincipal.workspaceId", async () => {
    mockListAgents.mockResolvedValue([AGENT]);
    mockCreateTask.mockResolvedValue({ id: "task-4" });
    mockRunAgentTask.mockResolvedValue(succeededRun());

    const params = matchDelegateIntent("Agent1 add a task titled X")!;
    await delegateToAgentTool.handler(params, {
      userId: "owner-1",
      userRole: "ops",
      agentPrincipal: {
        agentId: "a",
        role: "ops",
        workspaceId: "ws-1",
        ownerUserId: "owner-1",
      },
    });

    expect(mockListAgents).toHaveBeenCalledWith("ws-1");
  });

  test("tolerant name matching: 'Agent 1' resolves the 'Agent1' record", async () => {
    mockListAgents.mockResolvedValue([AGENT]);
    mockCreateTask.mockResolvedValue({ id: "task-5" });
    mockRunAgentTask.mockResolvedValue(succeededRun());

    const params = matchDelegateIntent("tell Agent-1 to add a task")!;
    const res = await delegateToAgentTool.handler(params, OWNER_CTX);

    expect(res.ok).toBe(true);
    expect(mockCreateTask).toHaveBeenCalled();
  });
});

describe("delegate_to_agent tool definition", () => {
  test("capability is open and it does not double-gate the human", () => {
    expect(delegateToAgentTool.name).toBe("delegate_to_agent");
    expect(delegateToAgentTool.capability).toBe("*");
    expect(delegateToAgentTool.requiresConfirmation).toBe(false);
  });
});
