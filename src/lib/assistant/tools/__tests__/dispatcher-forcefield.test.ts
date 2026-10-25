/**
 * Dispatcher Forcefield containment (step 1c). Proves the wiring:
 *   - an AGENT tool call that trips a decoy is REFUSED (the containment already
 *     revoked its scope + recorded the trip inside guardAgentAction);
 *   - a clean action passes through, and guardAgentAction saw the real action
 *     (workspace, agent, tool name, serialized params);
 *   - the HUMAN path is never subject to Forcefield;
 *   - an unexpected error in the check degrades OPEN (does not break the agent),
 *     since the OGIAM gate already authorized the action.
 * guardAgentAction is mocked so the test controls the verdict with no DB.
 */
const mockGuard = jest.fn();
jest.mock("@/lib/forcefield/contain", () => ({ guardAgentAction: (...a: unknown[]) => mockGuard(...a) }));
jest.mock("@/lib/forcefield/contain-live", () => ({ liveContainmentDeps: () => ({}) }));
// Let OGIAM authorize a benign read without a database (same as dispatcher-agent).
jest.mock("@/lib/ogiam/ledger", () => ({
  ...jest.requireActual("@/lib/ogiam/ledger"),
  recordDecision: () => Promise.resolve({ id: "d", seq: 1, entryHash: "h" }),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));
jest.mock("@/lib/notifications/in-app", () => ({ notify: () => Promise.resolve({ id: "n" }) }));

import { z } from "zod";
import { tryDispatchTool, dispatchToolByName } from "@/lib/assistant/tools/dispatcher";
import { registerTool, __resetRegistryForTests } from "@/lib/assistant/tools/registry";
import type { ToolContext } from "@/lib/assistant/tools/types";

const agentCtx: ToolContext = {
  userId: "agent-1",
  userRole: "ops",
  workspaceId: "ws-1",
  agentPrincipal: { agentId: "agent-1", role: "ops", workspaceId: "ws-1", ownerUserId: "owner-1" },
};
const humanCtx: ToolContext = { userId: "u1", userRole: "cto", workspaceId: "ws-1" };

const ALLOW = { decision: { action: "allow", revokeAgentScope: false, openIncident: false, reason: "no decoy touched", hits: [] }, contained: false, revoked: false, recorded: false };
const QUARANTINE = { decision: { action: "quarantine", revokeAgentScope: true, openIncident: true, reason: "honeypot tool invoked [MCP manifest]", hits: [] }, contained: true, revoked: true, recorded: true };

beforeEach(() => {
  __resetRegistryForTests();
  mockGuard.mockReset();
  mockGuard.mockResolvedValue(ALLOW);
  registerTool({
    name: "read_status",
    description: "read status",
    capability: "*",
    requiresConfirmation: false,
    paramSchema: z.object({}).passthrough(),
    matchIntent: (m: string) => (m.includes("status") ? { note: "hello" } : null),
    handler: async () => ({ ok: true as const, data: { ran: "read_status" }, answer: "done", sources: [] }),
  });
});

it("refuses an agent tool call that trips a decoy, after containment ran", async () => {
  mockGuard.mockResolvedValue(QUARANTINE);
  const res = await tryDispatchTool("show status", agentCtx);
  expect(res?.result.ok).toBe(false);
  if (res && !res.result.ok) {
    expect(res.result.code).toBe("capability");
    expect(res.result.message).toMatch(/Forcefield/);
    expect(res.result.message).toMatch(/quarantined/);
  }
});

it("passes a clean action through, and guardAgentAction saw the real action", async () => {
  const res = await tryDispatchTool("show status", agentCtx);
  expect(res?.result.ok).toBe(true);
  // Twice: the tool CALL (before it runs) and the tool OUTPUT (after it runs).
  expect(mockGuard).toHaveBeenCalledTimes(2);
  const action = mockGuard.mock.calls[0][0] as { workspaceId: string; agentId: string; kind: string; tool: string; payload: string };
  expect(action).toMatchObject({ workspaceId: "ws-1", agentId: "agent-1", kind: "tool_call", tool: "read_status" });
  expect(action.payload).toContain("hello"); // the serialized params, where an exfil-token decoy would be caught
  const output = mockGuard.mock.calls[1][0] as { kind: string; tool: string; output: string };
  expect(output).toMatchObject({ kind: "tool_output", tool: "read_status" });
  expect(output.output).toContain("read_status"); // the serialized result, where a honey-row or decoy credential would be caught
});

it("withholds a tool's OUTPUT when a decoy appears in it (the tool ran, the agent never sees the result)", async () => {
  mockGuard.mockResolvedValueOnce(ALLOW).mockResolvedValueOnce(QUARANTINE);
  const res = await tryDispatchTool("show status", agentCtx);
  expect(res?.result.ok).toBe(false);
  if (res && !res.result.ok) {
    expect(res.result.code).toBe("capability");
    expect(res.result.message).toMatch(/decoy reached in tool output/);
    expect(res.result.message).not.toContain("read_status\"");
  }
});

it("runs an agent's call to an UNREGISTERED tool name through the tripwire (a honeypot tool has no handler)", async () => {
  mockGuard.mockResolvedValue(QUARANTINE);
  const res = await dispatchToolByName("admin_bulk_export_abc123", { all: true }, agentCtx);
  expect(res).toBeNull();
  expect(mockGuard).toHaveBeenCalledTimes(1);
  expect(mockGuard.mock.calls[0][0]).toMatchObject({ kind: "tool_call", tool: "admin_bulk_export_abc123", agentId: "agent-1" });
});

it("does not run the tripwire for a HUMAN naming an unknown tool", async () => {
  const res = await dispatchToolByName("admin_bulk_export_abc123", {}, humanCtx);
  expect(res).toBeNull();
  expect(mockGuard).not.toHaveBeenCalled();
});

it("never subjects the HUMAN path to Forcefield", async () => {
  const res = await tryDispatchTool("show status", humanCtx);
  expect(res?.result.ok).toBe(true);
  expect(mockGuard).not.toHaveBeenCalled();
});

it("degrades OPEN if the containment check throws (does not break the governed agent)", async () => {
  mockGuard.mockRejectedValue(new Error("containment backend down"));
  const res = await tryDispatchTool("show status", agentCtx);
  expect(res?.result.ok).toBe(true); // OGIAM already authorized; Forcefield is secondary
});
