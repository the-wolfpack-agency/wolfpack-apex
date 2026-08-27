/**
 * The ceiling, proved at the executor rather than at the helper.
 *
 * A unit test of checkAndRecordOperation proves the arithmetic. It does not
 * prove the executor consults it, and that is the half that actually stops a
 * runaway: an agent hitting its ceiling must not reach the network at all.
 *
 * So these assert on the stubbed fetch and form executor. If somebody deletes
 * the guard, the run still "succeeds" and only these fail.
 *
 * Same harness as agent-operation-e2e: dispatcher, registry, gate, executor
 * REAL; owner-role resolution, token mint and HTTP stubbed.
 */
jest.mock("@/lib/ogiam/ledger", () => ({
  ...jest.requireActual("@/lib/ogiam/ledger"),
  recordDecision: jest.fn(() => Promise.resolve({ id: "d", seq: 1, entryHash: "h" })),
}));
const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
jest.mock("@/lib/db", () => ({
  /* The write-approval gate reads instinct_agents.requires_write_approval.
     FALSE is the shipped default and what every assertion here assumes: an
     agent nobody has put behind the gate keeps working exactly as before. */
  query: jest.fn(() => Promise.resolve({ rows: [{ requires_write_approval: false }] })),
  safeQuery: jest.fn(() => Promise.resolve({ rows: [] })),
  writeQuery: jest.fn(() => Promise.resolve({ rows: [] })),
}));

import "@/lib/assistant/tools";
import { runAgentTask } from "@/lib/agents/tasks/executor";
import { _setContainmentStateForTests, _setRunSpendForTests } from "@/lib/containment/state";
import { _setCeilingForTests, CEILING_NOT_UNDER_TEST } from "@/lib/agents/ceiling";

const OVER_CEILING = {
  allowed: false,
  outcome: "refused_over_ceiling" as const,
  used: 60,
  ceiling: 60,
  reason: "agent has used 60 of 60 operations this hour",
};

beforeEach(() => {
  _setContainmentStateForTests({ agentsEnabled: true, readable: true });
  _setRunSpendForTests({ tokens: 0, durationMs: 0, egressCalls: 0, spendCents: 0 });
  mockTrack.mockClear();
});
afterAll(() => {
  _setContainmentStateForTests(null);
  _setRunSpendForTests(null);
  _setCeilingForTests(null);
});

const TASK = {
  id: "task-ceiling",
  goal: "Create a QR code titled AGENT1 that is linked to ogiam.com",
  agentId: "agent-1",
  role: "dev",
  workspaceId: "ws-1",
  ownerUserId: "owner-9",
};

function deps(fetchImpl: jest.Mock) {
  return {
    lookupProcedure: (async () => null) as never,
    recordProcedure: (async () => null) as never,
    ground: (async () => ({ used: false, hits: 0, snippets: [] })) as never,
    getOwnerRole: (async () => ({ role: "dev", workspaceId: "ws-1" })) as never,
    mintToken: (async () => "onbehalf-token") as never,
    origin: (() => "https://internal.example") as never,
    fetchImpl: fetchImpl as never,
  };
}

function okResponse() {
  return jest.fn().mockResolvedValue(
    new Response(JSON.stringify({ code: { slug: "x9" }, shortUrl: "/q/x9" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("an agent over its hourly ceiling", () => {
  it("never reaches the network", async () => {
    _setCeilingForTests(OVER_CEILING);
    const fetchImpl = okResponse();
    const out = await runAgentTask(TASK, deps(fetchImpl));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out.status).not.toBe("succeeded");
  });

  /* Blocked, not errored: blocked notifies the owner, and the person
     accountable for the agent should hear it looping from us rather than
     from their bill. */
  it("blocks the step and says why, naming the number", async () => {
    _setCeilingForTests(OVER_CEILING);
    const out = await runAgentTask(TASK, deps(okResponse()));
    const blocked = out.steps.find((s) => s.outcome === "blocked");
    expect(blocked).toBeDefined();
    expect(blocked!.detail).toMatch(/60 of 60/);
    expect(blocked!.detail).toMatch(/ceiling/i);
  });

  it("emits agent.operation_ceiling_hit so the fleet view can show it", async () => {
    _setCeilingForTests(OVER_CEILING);
    await runAgentTask(TASK, deps(okResponse()));
    const hit = mockTrack.mock.calls.find((c) => c[0] === "agent.operation_ceiling_hit");
    expect(hit).toBeDefined();
    expect(hit![3]).toMatchObject({ agent_id: "agent-1", used: 60, ceiling: 60 });
  });
});

describe("an agent under its ceiling", () => {
  /* The control group. Without it, a guard that refused unconditionally would
     pass every assertion above. */
  it("executes normally", async () => {
    _setCeilingForTests(CEILING_NOT_UNDER_TEST);
    const fetchImpl = okResponse();
    const out = await runAgentTask(TASK, deps(fetchImpl));
    expect(fetchImpl).toHaveBeenCalled();
    expect(out.status).toBe("succeeded");
  });
});
