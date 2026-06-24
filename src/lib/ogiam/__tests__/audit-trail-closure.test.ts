/**
 * audit-trail-closure.test.ts
 *
 * End-to-end CLOSURE of the agent audit trail through the REAL governance
 * chain: dispatcher -> real authorize() -> real recordDecision() -> tool
 * handler -> real recordActionOutcome() -> Brain ingest. Only the lowest
 * layers (the Postgres client + the Brain ingest + analytics) are stubbed.
 *
 * The per-boundary tests (ledger-write, outcome-write, dispatcher-outcome) each
 * mock their neighbours, so none of them prove the SEQ produced by
 * recordDecision is the SAME seq the outcome is linked under. This test does:
 * it asserts one decision row and one outcome row are written with a matching
 * seq, and the Brain summary carries the decision's rule. That closure is the
 * thing a `decision.recordedSeq` regression would silently break - no data
 * lost, prompt-to-response is intact.
 */

const mockConnect = jest.fn();
jest.mock("@/lib/db", () => ({
  pool: { connect: (...a: unknown[]) => mockConnect(...a) },
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

const mockIngestAgentAction = jest.fn().mockResolvedValue(undefined);
jest.mock("@/lib/agents/audit/brain-ingest", () => ({
  ingestAgentAction: (...a: unknown[]) => mockIngestAgentAction(...a),
}));

import { z } from "zod";
import { tryDispatchTool } from "@/lib/assistant/tools/dispatcher";
import { registerTool, __resetRegistryForTests } from "@/lib/assistant/tools/registry";
import type { ToolContext } from "@/lib/assistant/tools/types";

/** Captures every INSERT the real ledger issues across the connections it
 *  opens (recordDecision opens one, recordActionOutcome opens another). */
function makeCapturingDb() {
  const decisionInserts: unknown[][] = [];
  const outcomeInserts: unknown[][] = [];
  const newClient = () => ({
    release: jest.fn(),
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      if (/^\s*SELECT seq, entry_hash/i.test(sql)) return { rows: [] }; // genesis
      if (/^\s*INSERT INTO ogiam_decisions/i.test(sql)) {
        decisionInserts.push(params ?? []);
        return { rows: [{ id: "dec-1" }] };
      }
      if (/^\s*INSERT INTO ogiam_action_outcomes/i.test(sql)) {
        outcomeInserts.push(params ?? []);
        return { rows: [] };
      }
      return { rows: [] }; // BEGIN / COMMIT / advisory lock
    }),
  });
  mockConnect.mockImplementation(async () => newClient());
  return { decisionInserts, outcomeInserts };
}

const agentCtx: ToolContext = {
  userId: "agent-1",
  userRole: "ops",
  workspaceId: "ws-1",
  agentPrincipal: { agentId: "agent-1", role: "ops", workspaceId: "ws-1", ownerUserId: "owner-1" },
};

const ORIGINAL_DB_URL = process.env.DATABASE_URL;
beforeEach(() => {
  __resetRegistryForTests();
  mockConnect.mockReset();
  mockIngestAgentAction.mockClear();
  process.env.DATABASE_URL = "postgres://test";
  registerTool({
    name: "read_status",
    description: "read_status",
    capability: "*",
    requiresConfirmation: false, // read-only -> allow path
    paramSchema: z.object({}).passthrough(),
    matchIntent: (m: string) => (m.includes("status") ? {} : null),
    handler: async () => ({ ok: true as const, data: {}, answer: "all systems green", sources: [] }),
  });
});
afterAll(() => {
  if (ORIGINAL_DB_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DB_URL;
});

describe("agent audit-trail closure (real authorize + real ledger)", () => {
  it("writes exactly one decision and one outcome with a MATCHING seq, and ingests the rule", async () => {
    const { decisionInserts, outcomeInserts } = makeCapturingDb();

    const res = await tryDispatchTool("show status", agentCtx);
    expect(res?.result.ok).toBe(true);

    // Exactly one decision row (genesis, seq 1). Columns: workspace_id=$1, seq=$2.
    expect(decisionInserts).toHaveLength(1);
    const decisionWorkspace = decisionInserts[0][0];
    const decisionSeq = decisionInserts[0][1];
    expect(decisionWorkspace).toBe("ws-1");
    expect(decisionSeq).toBe(1);

    // Exactly one outcome row, linked to the SAME seq. Columns:
    // workspace_id=$1, decision_seq=$2, agent_id=$3, ok=$4.
    expect(outcomeInserts).toHaveLength(1);
    expect(outcomeInserts[0][0]).toBe("ws-1");
    expect(outcomeInserts[0][1]).toBe(decisionSeq); // closure: outcome links the real decision seq
    expect(outcomeInserts[0][2]).toBe("agent-1");
    expect(outcomeInserts[0][3]).toBe(true);

    // The Brain learning summary carries the agent, tool, outcome, and the
    // deterministic rule that fired - no data lost from the learning loop.
    expect(mockIngestAgentAction).toHaveBeenCalledTimes(1);
    const brain = mockIngestAgentAction.mock.calls[0][0];
    expect(brain).toMatchObject({
      workspaceId: "ws-1",
      agentId: "agent-1",
      tool: "read_status",
      outcome: "ok",
      resultRedacted: "all systems green",
    });
    expect(typeof brain.ruleId).toBe("string");
    expect(brain.ruleId.length).toBeGreaterThan(0);
  });
});
