/**
 * The data-egress gate - the platform's generality proof. It governs arbitrary
 * text (not code), on the same runtime, with the same verdicts + transparency +
 * (deterministic) no-model guarantee. This is what makes the Agent Gate a general
 * governed checkpoint, not a code tool.
 */
import { dataEgressGate } from "@/lib/gates/data-egress-gate";
import { runGate } from "@/lib/gates/run-gate";

const ctx = { workspaceId: "w1", actorId: "u1", policy: { frameworks: ["GDPR"], allowModelData: "none" as const } };

it("allow: ordinary text with no sensitive data is safe to send", async () => {
  const r = await runGate(dataEgressGate, { text: "Summarize the Q3 roadmap for the team." }, ctx);
  expect(r.verdict).toBe("allow");
  expect(r.output?.redactions).toBe(0);
  expect(r.output?.redactedText).toBe("Summarize the Q3 roadmap for the team.");
  expect(r.transparency.modelInvoked).toBeNull(); // never sends to a model to decide
});

it("require_human: secrets/PII are detected and a REDACTED version is returned (not auto-sent)", async () => {
  const text = "email jane@acme.com and use key sk-ant-abcdefghijklmnopqrstuvwxyz1234567890 for the call";
  const r = await runGate(dataEgressGate, { text, destination: "OpenAI" }, ctx);
  expect(r.verdict).toBe("require_human");
  expect(r.output?.redactions).toBeGreaterThanOrEqual(2);
  expect(r.output?.redactedText).toContain("[REDACTED]");
  expect(r.output?.redactedText).not.toContain("jane@acme.com");
  expect(r.output?.redactedText).not.toContain("sk-ant-abcde");
  expect(r.reason).toMatch(/OpenAI/);
  expect(r.reason).toMatch(/NOT auto-sent/i);
  expect(r.transparency.modelInvoked).toBeNull();
});

it("runs on the same runtime: framework + audit stamped uniformly", async () => {
  const r = await runGate(dataEgressGate, { text: "hello" }, ctx);
  expect(r.transparency.frameworksApplied).toEqual(["GDPR"]);
  expect(r.audit).toMatchObject({ gate: "data-egress", workspaceId: "w1", actorId: "u1", verdict: "allow" });
});
