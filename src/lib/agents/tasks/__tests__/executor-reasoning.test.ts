/**
 * Executor reasoning fallback: when no deterministic tool matches an
 * instruction, the run reasons with the governed LLM instead of failing at
 * zero tokens. The reasoner is injected so no real model is called.
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
  goal: "break down the most popular AI agents by similarity and difference",
  agentId: "agent-1",
  role: "ops",
  workspaceId: "ws-1",
  ownerUserId: "owner-1",
};

beforeEach(() => mockTrackEvent.mockClear());

it("reasons when no tool matched, recording a ran 'reasoning' step (not a failure)", async () => {
  const dispatch = jest.fn().mockResolvedValue(null); // no tool matches
  const reason = jest.fn().mockResolvedValue({ ok: true, answer: "The popular agents cluster into..." });

  const out = await runAgentTask(task, {
    dispatch: dispatch as never,
    notifyOwner: jest.fn() as never,
    reason: reason as never,
  });

  expect(out.status).toBe("succeeded"); // was "failed" before this capability
  expect(out.steps).toHaveLength(1);
  expect(out.steps[0].outcome).toBe("ran");
  expect(out.steps[0].tool).toBe("reasoning");
  expect(out.steps[0].detail).toContain("The popular agents cluster into");

  // The governed reasoner received the instruction + agent identity.
  expect(reason).toHaveBeenCalledWith(
    expect.objectContaining({ agentId: "agent-1", role: "ops", workspaceId: "ws-1" }),
  );
  // The learning loop sees the reasoning.
  const reasoned = mockTrackEvent.mock.calls.find((c) => c[0] === "agent.reasoned");
  expect(reasoned).toBeDefined();
  expect(reasoned![3]).toMatchObject({ agent_id: "agent-1", task_id: "task-1" });
});

it("falls back to no_match when reasoning is unavailable (over budget / no provider)", async () => {
  const dispatch = jest.fn().mockResolvedValue(null);
  const reason = jest.fn().mockResolvedValue({ ok: false, detail: "over budget" });

  const out = await runAgentTask(task, {
    dispatch: dispatch as never,
    notifyOwner: jest.fn() as never,
    reason: reason as never,
  });

  expect(out.steps[0].outcome).toBe("no_match");
  // A run where nothing ran is still a failure (unchanged behavior).
  expect(out.status).toBe("failed");
  expect(mockTrackEvent.mock.calls.find((c) => c[0] === "agent.reasoned")).toBeUndefined();
});
