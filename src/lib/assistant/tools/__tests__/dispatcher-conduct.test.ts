/**
 * Dispatcher conduct gate (step 1d) - C-NO-SELF-TAMPER. Proves an AGENT is
 * refused a governance-control capability (settings.manage_team) even though the
 * gates above it allow the action, while the HUMAN path is never blocked by
 * conduct, and a benign agent capability passes. Forcefield + the OGIAM ledger
 * are mocked so the test isolates the conduct gate with no DB.
 *
 * (settings.manage_team is used because it does NOT match the OGIAM high-risk
 * fragments, so OGIAM allows it and control reaches the conduct gate. admin.*
 * would be escalated by OGIAM first - a different, also-correct stop.)
 */
jest.mock("@/lib/forcefield/contain", () => ({
  guardAgentAction: async () => ({ decision: { action: "allow", reason: "no decoy", hits: [] }, contained: false, revoked: false, recorded: false }),
}));
jest.mock("@/lib/forcefield/contain-live", () => ({ liveContainmentDeps: () => ({}) }));
jest.mock("@/lib/ogiam/ledger", () => ({
  ...jest.requireActual("@/lib/ogiam/ledger"),
  recordDecision: () => Promise.resolve({ id: "d", seq: 1, entryHash: "h" }),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));
jest.mock("@/lib/notifications/in-app", () => ({ notify: () => Promise.resolve({ id: "n" }) }));

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { tryDispatchTool } from "@/lib/assistant/tools/dispatcher";
import { registerTool, __resetRegistryForTests } from "@/lib/assistant/tools/registry";
import type { ToolContext } from "@/lib/assistant/tools/types";

const agentCtx: ToolContext = {
  userId: "agent-1",
  userRole: "ops",
  workspaceId: "ws-1",
  agentPrincipal: { agentId: "agent-1", role: "ops", workspaceId: "ws-1", ownerUserId: "owner-1" },
};
const humanCtx: ToolContext = { userId: "u1", userRole: "cto", workspaceId: "ws-1" };

beforeEach(() => {
  (trackEvent as jest.Mock).mockClear();
  __resetRegistryForTests();
  registerTool({
    name: "manage_governance",
    description: "manage governance",
    capability: "settings.manage_team",
    requiresConfirmation: false,
    paramSchema: z.object({}).passthrough(),
    matchIntent: (m: string) => (m.includes("manage") ? {} : null),
    handler: async () => ({ ok: true as const, data: { ran: "manage_governance" }, answer: "done", sources: [] }),
  });
  registerTool({
    name: "read_status",
    description: "read status",
    capability: "*",
    requiresConfirmation: false,
    paramSchema: z.object({}).passthrough(),
    matchIntent: (m: string) => (m.includes("status") ? {} : null),
    handler: async () => ({ ok: true as const, data: { ran: "read_status" }, answer: "done", sources: [] }),
  });
});

it("refuses an AGENT invoking a governance-control capability (C-NO-SELF-TAMPER)", async () => {
  const res = await tryDispatchTool("manage the settings", agentCtx);
  expect(res?.result.ok).toBe(false);
  if (res && !res.result.ok) {
    expect(res.result.code).toBe("capability");
    expect(res.result.message).toMatch(/C-NO-SELF-TAMPER/);
  }
  // The denial emits a workspace-scoped enforcement signal so it is counted in
  // the effectiveness rollup (closes the conduct-self-tamper capture gap).
  expect(trackEvent).toHaveBeenCalledWith(
    "agent.conduct_denied",
    "agent-1",
    "ops",
    expect.objectContaining({ workspace_id: "ws-1", capability: "settings.manage_team", rule_id: "C-NO-SELF-TAMPER" }),
  );
});

it("allows an agent invoking a benign, non-governance capability", async () => {
  const res = await tryDispatchTool("show status", agentCtx);
  expect(res?.result.ok).toBe(true);
});

it("never blocks the HUMAN path by conduct", async () => {
  const res = await tryDispatchTool("manage the settings", humanCtx);
  // The human may or may not pass other gates, but conduct (agent-only) is never
  // the reason: no C-NO-SELF-TAMPER on a human.
  if (res && !res.result.ok) {
    expect(res.result.message).not.toMatch(/C-NO-SELF-TAMPER/);
  }
});
