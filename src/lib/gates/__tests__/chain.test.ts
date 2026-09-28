/**
 * The chain runner: advances on allow, and halts for exactly one reason at a
 * time - fixing (auto_fix), awaiting_human (require_human), or denied (deny) -
 * so no single step dead-ends the workflow silently. Proves the core promise:
 * the flow keeps going unless a human (or a hard deny) is the intended gate.
 */
import { runChain, type ChainStep } from "@/lib/gates/chain";
import type { GateDefinition, GateResult, GateVerdict } from "@/lib/gates/types";

// A stub gate that returns a fixed verdict and passes an output forward.
function stubGate(name: string, verdict: GateVerdict, output?: unknown): GateDefinition<unknown, unknown> {
  return {
    name,
    purpose: "stub",
    async evaluate(_input: unknown, ctx: { workspaceId: string; actorId: string }): Promise<GateResult> {
      return {
        verdict,
        output,
        findings: [],
        reason: `${name}:${verdict}`,
        transparency: { checksRun: [name], dataSeen: "", modelInvoked: null, frameworksApplied: [], explanation: "" },
        audit: { gate: name, verdict, ruleId: `R-${name}`, reason: "", workspaceId: ctx.workspaceId, actorId: ctx.actorId },
      };
    },
  };
}

const ctx = { workspaceId: "w1", actorId: "u1", policy: { frameworks: [], allowModelData: "none" as const } };
const step = (g: GateDefinition<unknown, unknown>, input: ChainStep["input"] = () => ({})): ChainStep => ({ gate: g, input });

it("completed: every gate allows -> runs them all in order", async () => {
  const r = await runChain([step(stubGate("review", "allow")), step(stubGate("deploy-preview", "allow")), step(stubGate("preview-test", "allow"))], ctx);
  expect(r.status).toBe("completed");
  expect(r.ranSteps.map((s) => s.gate)).toEqual(["review", "deploy-preview", "preview-test"]);
  expect(r.atGate).toBeUndefined();
});

it("awaiting_human: stops at the first require_human (the intended production gate)", async () => {
  const r = await runChain([step(stubGate("review", "allow")), step(stubGate("prod-deploy", "require_human")), step(stubGate("never", "allow"))], ctx);
  expect(r.status).toBe("awaiting_human");
  expect(r.atGate).toBe("prod-deploy");
  expect(r.ranSteps.map((s) => s.gate)).toEqual(["review", "prod-deploy"]); // "never" did not run
});

it("fixing: an auto_fix pauses the chain for the async CI re-run", async () => {
  const r = await runChain([step(stubGate("review", "allow")), step(stubGate("ci-autofix", "auto_fix"))], ctx);
  expect(r.status).toBe("fixing");
  expect(r.atGate).toBe("ci-autofix");
});

it("denied: a hard deny stops the chain immediately", async () => {
  const r = await runChain([step(stubGate("review", "deny")), step(stubGate("never", "allow"))], ctx);
  expect(r.status).toBe("denied");
  expect(r.atGate).toBe("review");
  expect(r.ranSteps).toHaveLength(1);
});

it("carries an allow's output forward to the next gate's input", async () => {
  const seen: unknown[] = [];
  const consumer: GateDefinition<unknown, unknown> = {
    name: "consumer", purpose: "s",
    async evaluate(input: unknown, c: { workspaceId: string; actorId: string }): Promise<GateResult> {
      seen.push(input);
      return { verdict: "allow", findings: [], reason: "", transparency: { checksRun: [], dataSeen: "", modelInvoked: null, frameworksApplied: [], explanation: "" }, audit: { gate: "consumer", verdict: "allow", ruleId: "R", reason: "", workspaceId: c.workspaceId, actorId: c.actorId } };
    },
  };
  await runChain([step(stubGate("producer", "allow", { diff: "D" })), { gate: consumer, input: (prior) => prior }], ctx);
  expect(seen[0]).toEqual({ diff: "D" });
});
