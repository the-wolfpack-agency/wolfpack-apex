/**
 * Proves every OGIAM agent run is governed by the OGIAM Agent Constitution:
 * the constitution is attached to the run context the tools receive, and the
 * application is recorded to analytics (the learning-loop + agent-log signal).
 */

jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

import { trackEvent } from "@/lib/analytics";
import { runAgentTask, type ExecutableTask } from "@/lib/agents/tasks/executor";

/* Containment gate: these suites exercise the executor's own behaviour, not the
   stop or the budget, so they declare an enabled workspace with a fresh ledger.
   Saying it out loud beats a gate that silently does not apply — the executor
   fails closed by design, and a suite that did not opt in would be testing the
   refusal path without meaning to. Containment itself is covered in
   src/lib/containment/__tests__. */
import { _setContainmentStateForTests, _setRunSpendForTests } from "@/lib/containment/state";
import { _setCeilingForTests, CEILING_NOT_UNDER_TEST } from "@/lib/agents/ceiling";
beforeEach(() => {
  _setContainmentStateForTests({ agentsEnabled: true, readable: true });
  _setRunSpendForTests({ tokens: 0, durationMs: 0, egressCalls: 0, spendCents: 0 });
  _setCeilingForTests(CEILING_NOT_UNDER_TEST);
});
afterAll(() => {
  _setContainmentStateForTests(null);
  _setRunSpendForTests(null);
  _setCeilingForTests(null);
});


const mockTrackEvent = trackEvent as jest.MockedFunction<typeof trackEvent>;

const task: ExecutableTask = {
  id: "task-1",
  goal: "1. read status",
  agentId: "agent-1",
  role: "ops",
  workspaceId: "ws-1",
  ownerUserId: "owner-1",
};

function ran(tool: string, answer: string) {
  return { tool, result: { ok: true as const, data: {}, answer, sources: [] }, durationMs: 1 };
}

describe("runAgentTask constitution governance", () => {
  beforeEach(() => mockTrackEvent.mockClear());

  it("attaches the constitution to the run context and records it", async () => {
    const dispatch = jest.fn().mockResolvedValue(ran("read_status", "ok"));
    await runAgentTask(task, {
      dispatch: dispatch as never,
      notifyOwner: jest.fn() as never,
      constitution: { version: "9.9.9", text: "TEST CONSTITUTION BODY" },
    });

    const call = mockTrackEvent.mock.calls.find(
      (c) => c[0] === "agent.constitution_applied",
    );
    expect(call).toBeDefined();
    expect(call![1]).toBe("agent-1"); // userId
    expect(call![2]).toBe("ops"); // role
    const meta = call![3] as Record<string, unknown>;
    expect(meta.constitution_version).toBe("9.9.9");
    expect(meta.task_id).toBe("task-1");
    expect(meta.workspace_id).toBe("ws-1");

    // The tools receive the constitution on the agent run context.
    const ctx = dispatch.mock.calls[0][1] as { constitution: { text: string; version: string } };
    expect(ctx.constitution.text).toBe("TEST CONSTITUTION BODY");
    expect(ctx.constitution.version).toBe("9.9.9");
  });

  it("defaults to the bundled constitution when none is injected", async () => {
    const dispatch = jest.fn().mockResolvedValue(ran("read_status", "ok"));
    await runAgentTask(task, { dispatch: dispatch as never, notifyOwner: jest.fn() as never });

    const call = mockTrackEvent.mock.calls.find(
      (c) => c[0] === "agent.constitution_applied",
    );
    expect(call).toBeDefined();
    const meta = call![3] as Record<string, unknown>;
    // The real bundled version, shape X.Y.Z.
    expect(String(meta.constitution_version)).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
