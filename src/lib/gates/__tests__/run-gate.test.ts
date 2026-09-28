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
  it("passes ordinary text through on full, but still scrubs recognizable secrets", async () => {
    const a = policyEnforcedAgent(agent, { frameworks: [], allowModelData: "full" });
    await a!.complete({ prompt: "fix the reading time helper", feature: "t" });
    expect(agentSpy).toHaveBeenCalledWith({ prompt: "fix the reading time helper", feature: "t" });
    agentSpy.mockClear();
    // even under "full", a provider key never reaches the model.
    await a!.complete({ prompt: "here is the key sk-ant-abcdefghijklmnopqrstuvwxyz12345 fix it", feature: "t" });
    expect(agentSpy.mock.calls[0][0].prompt).toContain("[REDACTED]");
    expect(agentSpy.mock.calls[0][0].prompt).not.toContain("sk-ant-abcde");
  });
  it("redacts prompts before the model on redacted (default scrub + client patterns)", async () => {
    const a = policyEnforcedAgent(agent, { frameworks: [], allowModelData: "redacted", redactions: ["internalCodeName"] });
    await a!.complete({ prompt: "the internalCodeName project, email a@b.com", feature: "t" });
    const sent = agentSpy.mock.calls[0][0].prompt;
    expect(sent).not.toContain("internalCodeName"); // client pattern
    expect(sent).not.toContain("a@b.com");           // default PII scrub
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
