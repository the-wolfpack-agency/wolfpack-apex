/**
 * Governed executor tests. The dispatcher and the notifier are injected, so we
 * prove the loop behavior without a database or the assistant: every step runs
 * under the agent identity, a gate block stops the run and escalates to the
 * owner, and unmatched or failing steps are recorded correctly.
 */

jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

import { runAgentTask, type ExecutableTask } from "@/lib/agents/tasks/executor";

const task: ExecutableTask = {
  id: "task-1",
  goal: "1. read status\n2. delete everything",
  agentId: "agent-1",
  role: "ops",
  workspaceId: "ws-1",
  ownerUserId: "owner-1",
};

function ran(tool: string, answer: string) {
  return { tool, result: { ok: true as const, data: {}, answer, sources: [] }, durationMs: 1 };
}
function gateBlock(tool: string) {
  return {
    tool,
    result: { ok: false as const, code: "capability" as const, message: "OGIAM escalate: high-risk action (rule R-HIGHRISK-MUTATION-ESCALATE)" },
    durationMs: 1,
  };
}

describe("runAgentTask", () => {
  it("runs every step under the agent identity and succeeds", async () => {
    const dispatch = jest.fn()
      .mockResolvedValueOnce(ran("read_status", "status ok"))
      .mockResolvedValueOnce(ran("read_more", "more ok"));
    const notifyOwner = jest.fn();
    const out = await runAgentTask(task, { dispatch: dispatch as never, notifyOwner: notifyOwner as never });

    expect(out.status).toBe("succeeded");
    expect(out.steps.map((s) => s.outcome)).toEqual(["ran", "ran"]);
    expect(notifyOwner).not.toHaveBeenCalled();
    // Each dispatch ran as the agent principal (enforce attribution).
    const ctx = dispatch.mock.calls[0][1];
    expect(ctx.agentPrincipal.agentId).toBe("agent-1");
    expect(ctx.userId).toBe("agent-1");
  });

  it("stops and escalates to the owner when a step is gate-blocked", async () => {
    const dispatch = jest.fn()
      .mockResolvedValueOnce(ran("read_status", "ok"))
      .mockResolvedValueOnce(gateBlock("delete_everything"));
    const notifyOwner = jest.fn().mockResolvedValue({ id: "n1" });
    const out = await runAgentTask(task, { dispatch: dispatch as never, notifyOwner: notifyOwner as never });

    expect(out.status).toBe("blocked");
    expect(out.steps[1].outcome).toBe("blocked");
    // The owner is notified for approval, and the run stops at the block.
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    const arg = notifyOwner.mock.calls[0][0];
    expect(arg.userId).toBe("owner-1");
    expect(arg.category).toBe("agent");
    expect(arg.sourceId).toBe("task-1");
    expect(dispatch).toHaveBeenCalledTimes(2); // did not run a third step
  });

  it("records a step with no matching tool and continues", async () => {
    const dispatch = jest.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(ran("read_more", "ok"));
    const out = await runAgentTask(task, { dispatch: dispatch as never, notifyOwner: jest.fn() as never });
    expect(out.steps[0].outcome).toBe("no_match");
    expect(out.steps[1].outcome).toBe("ran");
    expect(out.status).toBe("succeeded");
  });

  it("fails safe when a dispatch throws", async () => {
    const dispatch = jest.fn().mockRejectedValue(new Error("boom"));
    const out = await runAgentTask(task, {
      dispatch: dispatch as never, notifyOwner: jest.fn() as never,
      lookupProcedure: jest.fn().mockResolvedValue(null) as never,
      recordProcedure: jest.fn() as never,
    });
    expect(out.status).toBe("failed");
    expect(out.steps[0].outcome).toBe("error");
  });
});

describe("cumulative memory inheritance", () => {
  it("reuses a promoted procedure and does NOT relearn it", async () => {
    const dispatch = jest.fn().mockResolvedValue(ran("read_status", "ok"));
    const lookupProcedure = jest.fn().mockResolvedValue({
      plan: [{ instruction: "inherited step", tool: "read_status" }],
    });
    const recordProcedure = jest.fn();
    const out = await runAgentTask(
      { ...task, goal: "do the known thing" },
      { dispatch: dispatch as never, notifyOwner: jest.fn() as never, lookupProcedure: lookupProcedure as never, recordProcedure: recordProcedure as never },
    );
    expect(out.inherited).toBe(true);
    // The inherited plan was run (one step), not the planner's split of the goal.
    expect(dispatch).toHaveBeenCalledWith("inherited step", expect.anything());
    // An inherited plan is not re-recorded.
    expect(recordProcedure).not.toHaveBeenCalled();
  });

  it("records a freshly explored successful plan for future agents to inherit", async () => {
    const dispatch = jest.fn()
      .mockResolvedValueOnce(ran("read_status", "ok"))
      .mockResolvedValueOnce(ran("read_more", "ok"));
    const lookupProcedure = jest.fn().mockResolvedValue(null);
    const recordProcedure = jest.fn().mockResolvedValue({ status: "promoted" });
    const out = await runAgentTask(
      { ...task, goal: "read status\nread more" },
      { dispatch: dispatch as never, notifyOwner: jest.fn() as never, lookupProcedure: lookupProcedure as never, recordProcedure: recordProcedure as never },
    );
    expect(out.inherited).toBe(false);
    expect(out.status).toBe("succeeded");
    expect(recordProcedure).toHaveBeenCalledTimes(1);
    const arg = recordProcedure.mock.calls[0][0];
    expect(arg.goal).toBe("read status\nread more");
    expect(arg.plan).toHaveLength(2);
  });

  it("does NOT record a blocked task (only fully successful plans are learned)", async () => {
    const dispatch = jest.fn()
      .mockResolvedValueOnce(ran("read_status", "ok"))
      .mockResolvedValueOnce(gateBlock("delete_everything"));
    const recordProcedure = jest.fn();
    const out = await runAgentTask(task, {
      dispatch: dispatch as never, notifyOwner: jest.fn().mockResolvedValue({}) as never,
      lookupProcedure: jest.fn().mockResolvedValue(null) as never, recordProcedure: recordProcedure as never,
    });
    expect(out.status).toBe("blocked");
    expect(recordProcedure).not.toHaveBeenCalled();
  });
});
