/**
 * The capture half of the write-approval flow: when a governed AGENT proposes a
 * confirmation-gated mutation that the OGIAM gate ALLOWS, the dispatcher captures
 * the exact action as a pending approval (and still returns needs_confirmation,
 * so nothing mutates). The human path is unchanged: no agent principal, no
 * capture.
 */
const mockCreatePending = jest.fn();
const mockRecordDecision = jest.fn(
  (..._a: unknown[]): Promise<{ id: string; seq: number; entryHash: string } | null> =>
    Promise.resolve({ id: "d1", seq: 5, entryHash: "h" }),
);
jest.mock("@/lib/agents/approvals/store", () => ({ createPendingApproval: (...a: unknown[]) => mockCreatePending(...a) }));
jest.mock("@/lib/ogiam/ledger", () => ({
  ...jest.requireActual("@/lib/ogiam/ledger"),
  recordDecision: (...a: unknown[]) => mockRecordDecision(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));
jest.mock("@/lib/agents/audit/brain-ingest", () => ({ ingestAgentAction: jest.fn() }));

import { z } from "zod";
import { tryDispatchTool } from "@/lib/assistant/tools/dispatcher";
import { registerTool, __resetRegistryForTests } from "@/lib/assistant/tools/registry";
import type { ToolContext } from "@/lib/assistant/tools/types";

const agentCtx: ToolContext = {
  userId: "agent-1", userRole: "ops", workspaceId: "ws-1",
  agentPrincipal: { agentId: "agent-1", role: "ops", workspaceId: "ws-1", ownerUserId: "owner-1" },
};
const humanCtx: ToolContext = { userId: "u1", userRole: "cto", workspaceId: "ws-1" };

beforeEach(() => {
  jest.clearAllMocks();
  mockRecordDecision.mockResolvedValue({ id: "d1", seq: 5, entryHash: "h" });
  __resetRegistryForTests();
  // A benign mutation the OGIAM gate ALLOWS (low-risk, capability "*") but that
  // requires confirmation before it mutates.
  registerTool({
    name: "create_contact_test",
    description: "create a contact",
    capability: "*",
    requiresConfirmation: true,
    paramSchema: z.object({ name: z.string() }).passthrough(),
    matchIntent: (m: string) => (m.includes("create contact") ? { name: "Jane" } : null),
    handler: async () => ({ ok: true as const, data: {}, answer: "created", sources: [] }),
  });
});

it("an agent's confirmation-gated mutation captures a pending approval with the exact action", async () => {
  const res = await tryDispatchTool("create contact Jane", agentCtx);
  // Nothing mutated yet - it still needs human approval.
  expect(res?.result.ok).toBe(false);
  if (res && !res.result.ok) expect(res.result.code).toBe("needs_confirmation");
  // The proposal was captured for review, attributed to the agent + its owner.
  expect(mockCreatePending).toHaveBeenCalledTimes(1);
  expect(mockCreatePending).toHaveBeenCalledWith(
    expect.objectContaining({
      tool: "create_contact_test",
      agentId: "agent-1",
      ownerUserId: "owner-1",
      workspaceId: "ws-1",
      capability: "*",
      params: expect.objectContaining({ name: "Jane" }),
    }),
  );
});

it("the HUMAN path is unchanged: a confirmation-gated mutation captures NOTHING", async () => {
  const res = await tryDispatchTool("create contact Jane", humanCtx);
  expect(res?.result.ok).toBe(false);
  if (res && !res.result.ok) expect(res.result.code).toBe("needs_confirmation");
  expect(mockCreatePending).not.toHaveBeenCalled();
});
