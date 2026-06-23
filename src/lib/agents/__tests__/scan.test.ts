/**
 * Self-onboarding scan tests. The scan is deterministic discovery, so we pin
 * that it reads the real registry, marks allowed using the same gate the
 * dispatcher uses, and is reproducible.
 */

import { runSelfOnboardingScan, AGENT_SCAN_VERSION } from "@/lib/agents/scan";
import { canInvokeTool } from "@/lib/assistant/tools/gate";
import { getTools, registerTool, __resetRegistryForTests } from "@/lib/assistant/tools/registry";
import { AGENT_OPERATIONS } from "@/lib/agents/operations/registry";
import { z } from "zod";

function tool(name: string, capability: string, mutation = false) {
  registerTool({
    name,
    description: `desc ${name}`,
    capability,
    requiresConfirmation: mutation,
    paramSchema: z.object({}).passthrough(),
    matchIntent: () => null,
    handler: async () => ({ ok: true as const, data: {}, answer: "ok", sources: [] }),
  });
}

beforeEach(() => {
  __resetRegistryForTests();
  tool("read_open", "*");
  tool("read_cto_only", "cto");
  tool("delete_thing", "cto", true);
});

describe("runSelfOnboardingScan", () => {
  it("models every registered tool with an allowed flag consistent with the gate", () => {
    const model = runSelfOnboardingScan({ agentId: "a1", role: "ops", workspaceId: "ws" });
    expect(model.scanVersion).toBe(AGENT_SCAN_VERSION);
    expect(model.tools).toHaveLength(getTools().length);
    for (const t of model.tools) {
      expect(t.allowed).toBe(canInvokeTool("ops", t.capability));
    }
    // ops can use the open tool, not the cto-gated ones.
    const byName = Object.fromEntries(model.tools.map((t) => [t.name, t]));
    expect(byName["read_open"].allowed).toBe(true);
    expect(byName["read_cto_only"].allowed).toBe(false);
    expect(byName["delete_thing"].allowed).toBe(false);
    expect(byName["delete_thing"].isMutation).toBe(true);
  });

  it("a cto agent is allowed the cto-gated tools", () => {
    const model = runSelfOnboardingScan({ agentId: "a1", role: "cto", workspaceId: "ws" });
    const byName = Object.fromEntries(model.tools.map((t) => [t.name, t]));
    expect(byName["read_cto_only"].allowed).toBe(true);
    expect(byName["delete_thing"].allowed).toBe(true);
  });

  it("summary counts match the model and capabilities come from the role", () => {
    const model = runSelfOnboardingScan({ agentId: "a1", role: "ops", workspaceId: "ws" });
    expect(model.summary.toolCount).toBe(model.tools.length);
    expect(model.summary.allowedToolCount).toBe(model.tools.filter((t) => t.allowed).length);
    expect(model.summary.mutationCount).toBe(1);
    expect(model.summary.capabilityCount).toBe(model.capabilities.length);
    expect(Array.isArray(model.capabilities)).toBe(true);
  });

  it("reports the declarative operations the agent KNOWS, with gate-consistent allowed flags", () => {
    // create_qr_code is capability "*", so any role is allowed it.
    const opsModel = runSelfOnboardingScan({ agentId: "a1", role: "ops", workspaceId: "ws" });
    expect(opsModel.operations).toHaveLength(AGENT_OPERATIONS.length);
    expect(opsModel.summary.operationCount).toBe(AGENT_OPERATIONS.length);
    const qr = opsModel.operations.find((o) => o.id === "create_qr_code");
    expect(qr).toBeDefined();
    expect(qr?.summary).toMatch(/QR code/i);
    // Allowed flag matches the SAME gate the dispatcher + executor use.
    for (const op of opsModel.operations) {
      expect(op.allowed).toBe(canInvokeTool("ops", op.capability));
    }
    expect(qr?.allowed).toBe(true);
  });

  it("is deterministic: two scans of the same principal are identical", () => {
    const a = runSelfOnboardingScan({ agentId: "a1", role: "ops", workspaceId: "ws" });
    const b = runSelfOnboardingScan({ agentId: "a1", role: "ops", workspaceId: "ws" });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
