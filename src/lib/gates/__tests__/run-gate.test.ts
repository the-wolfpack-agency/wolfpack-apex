/**
 * The gate framework's cross-cutting guarantees: the client's data policy is
 * enforced by the framework (a gate cannot bypass it), and compliance frameworks
 * + audit are stamped uniformly.
 */
import { redactPrompt, policyEnforcedAgent, runGate } from "@/lib/gates/run-gate";
import type { GateAgent, GateDefinition, CompliancePolicy } from "@/lib/gates/types";

const agentSpy = jest.fn(async (req: { prompt: string; feature: string }) => ({ content: `saw:${req.prompt}`, model_used: "test-model" }));
const agent: GateAgent = { complete: agentSpy };

beforeEach(() => jest.clearAllMocks());

describe("redactPrompt", () => {
  it("strips configured patterns, tolerates a bad regex", () => {
    expect(redactPrompt("token=abc123 and email a@b.com", ["token=\\w+", "["])).toBe("[REDACTED] and email a@b.com");
  });
  it("no-ops with no patterns", () => {
    expect(redactPrompt("hello", [])).toBe("hello");
  });
});

describe("policyEnforcedAgent", () => {
  it("returns undefined when the policy forbids any model data (none)", () => {
    expect(policyEnforcedAgent(agent, { frameworks: [], allowModelData: "none" })).toBeUndefined();
  });
  it("passes the agent through on full", async () => {
    const a = policyEnforcedAgent(agent, { frameworks: [], allowModelData: "full" });
    await a!.complete({ prompt: "secret=xyz", feature: "t" });
    expect(agentSpy).toHaveBeenCalledWith({ prompt: "secret=xyz", feature: "t" });
  });
  it("redacts prompts before the model on redacted", async () => {
    const a = policyEnforcedAgent(agent, { frameworks: [], allowModelData: "redacted", redactions: ["secret=\\w+"] });
    await a!.complete({ prompt: "secret=xyz please fix", feature: "t" });
    expect(agentSpy).toHaveBeenCalledWith({ prompt: "[REDACTED] please fix", feature: "t" });
  });
});

describe("runGate", () => {
  const policy: CompliancePolicy = { frameworks: ["SOC2", "GDPR"], allowModelData: "none" };
  const ctx = { workspaceId: "w1", actorId: "u1", agent, policy };

  it("hands a gate NO agent when the policy forbids model data, and stamps frameworks + audit", async () => {
    let sawAgent: unknown = "unset";
    const def: GateDefinition<{ x: number }> = {
      name: "probe",
      purpose: "test",
      async evaluate(_input, c) {
        sawAgent = c.agent;
        return { verdict: "allow", findings: [], reason: "ok", transparency: { checksRun: ["c"], dataSeen: "x", modelInvoked: "leaked?", frameworksApplied: [], explanation: "" }, audit: { gate: "probe", verdict: "allow", ruleId: "R", reason: "ok", workspaceId: "", actorId: "" } };
      },
    };
    const r = await runGate(def, { x: 1 }, ctx);
    expect(sawAgent).toBeUndefined();                 // policy "none" -> gate got no agent
    expect(r.transparency.modelInvoked).toBeNull();   // forced null when no model was available
    expect(r.transparency.frameworksApplied).toEqual(["SOC2", "GDPR"]); // stamped by the framework
    expect(r.audit).toMatchObject({ gate: "probe", workspaceId: "w1", actorId: "u1", verdict: "allow" });
  });

  it("gives the gate a (redacting) agent when the policy allows it", async () => {
    let hadAgent = false;
    const def: GateDefinition<null> = {
      name: "probe2", purpose: "test",
      async evaluate(_i, c) { hadAgent = Boolean(c.agent); return { verdict: "allow", findings: [], reason: "", transparency: { checksRun: [], dataSeen: "", modelInvoked: null, frameworksApplied: [], explanation: "" }, audit: { gate: "probe2", verdict: "allow", ruleId: "R", reason: "", workspaceId: "", actorId: "" } }; },
    };
    await runGate(def, null, { ...ctx, policy: { frameworks: [], allowModelData: "redacted" } });
    expect(hadAgent).toBe(true);
  });
});
