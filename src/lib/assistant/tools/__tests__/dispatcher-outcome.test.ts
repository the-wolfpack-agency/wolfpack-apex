/**
 * Dispatcher action-OUTCOME capture (the RESULT half of the audit trail).
 *
 * Proves Phase: after a governed AGENT's tool executes, the dispatcher records
 * the redacted outcome linked to the decision seq and best-effort ingests a
 * concise summary into the Brain. Asserts:
 *   1. For an agent with a recorded decision seq, recordActionOutcome +
 *      ingestAgentAction fire with the linked seq, ok, code, and result text.
 *   2. The human path records NO outcome (monitor; outcomes are agent-only).
 *   3. A failing outcome / Brain write NEVER breaks dispatch (graceful).
 */

const mockRecordDecision = jest.fn();
const mockRecordOutcome = jest.fn();
jest.mock("@/lib/ogiam/ledger", () => ({
  ...jest.requireActual("@/lib/ogiam/ledger"),
  recordDecision: (...a: unknown[]) => mockRecordDecision(...a),
  recordActionOutcome: (...a: unknown[]) => mockRecordOutcome(...a),
}));

const mockIngestAgentAction = jest.fn();
jest.mock("@/lib/agents/audit/brain-ingest", () => ({
  ingestAgentAction: (...a: unknown[]) => mockIngestAgentAction(...a),
}));

jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

import { z } from "zod";
import { tryDispatchTool } from "@/lib/assistant/tools/dispatcher";
import { registerTool, __resetRegistryForTests } from "@/lib/assistant/tools/registry";
import type { ToolContext } from "@/lib/assistant/tools/types";

function tool(name: string, match: string, answer = "done") {
  registerTool({
    name,
    description: name,
    capability: "*",
    requiresConfirmation: false,
    paramSchema: z.object({}).passthrough(),
    matchIntent: (m: string) => (m.includes(match) ? {} : null),
    handler: async () => ({ ok: true as const, data: { ran: name }, answer, sources: [] }),
  });
}

const agentCtx: ToolContext = {
  userId: "agent-1",
  userRole: "ops",
  workspaceId: "ws-1",
  agentPrincipal: { agentId: "agent-1", role: "ops", workspaceId: "ws-1", ownerUserId: "owner-1" },
};
const humanCtx: ToolContext = { userId: "u1", userRole: "cto", workspaceId: "ws-1" };

beforeEach(() => {
  __resetRegistryForTests();
  mockRecordDecision.mockReset();
  mockRecordOutcome.mockReset().mockResolvedValue(undefined);
  mockIngestAgentAction.mockReset().mockResolvedValue(undefined);
  // The ledger reports the seq the decision was recorded under.
  mockRecordDecision.mockResolvedValue({ id: "d_1", seq: 99, entryHash: "h" });
  tool("read_status", "status", "all systems green");
});

describe("agent outcome capture", () => {
  it("records the outcome linked to the decision seq and ingests a summary", async () => {
    const res = await tryDispatchTool("show status", agentCtx);
    expect(res?.result.ok).toBe(true);

    expect(mockRecordOutcome).toHaveBeenCalledTimes(1);
    const outArg = mockRecordOutcome.mock.calls[0][0];
    expect(outArg).toMatchObject({
      workspaceId: "ws-1",
      decisionSeq: 99,
      agentId: "agent-1",
      ok: true,
      code: "ok",
      resultRedacted: "all systems green",
    });
    expect(typeof outArg.durationMs).toBe("number");

    expect(mockIngestAgentAction).toHaveBeenCalledTimes(1);
    expect(mockIngestAgentAction.mock.calls[0][0]).toMatchObject({
      agentId: "agent-1",
      tool: "read_status",
      outcome: "ok",
      resultRedacted: "all systems green",
    });
  });

  it("does NOT record an outcome on the human path", async () => {
    await tryDispatchTool("show status", humanCtx);
    expect(mockRecordOutcome).not.toHaveBeenCalled();
    expect(mockIngestAgentAction).not.toHaveBeenCalled();
  });

  it("does NOT record an outcome when the decision has no recorded seq", async () => {
    mockRecordDecision.mockResolvedValue(null); // ledger skipped/failed
    await tryDispatchTool("show status", agentCtx);
    expect(mockRecordOutcome).not.toHaveBeenCalled();
    expect(mockIngestAgentAction).not.toHaveBeenCalled();
  });
});

describe("outcome capture is graceful", () => {
  it("a failing outcome write never breaks dispatch", async () => {
    mockRecordOutcome.mockRejectedValue(new Error("db down"));
    const res = await tryDispatchTool("show status", agentCtx);
    expect(res?.result.ok).toBe(true);
  });

  it("a failing Brain ingest never breaks dispatch", async () => {
    mockIngestAgentAction.mockRejectedValue(new Error("embedder down"));
    const res = await tryDispatchTool("show status", agentCtx);
    expect(res?.result.ok).toBe(true);
  });
});
