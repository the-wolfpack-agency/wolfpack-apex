/**
 * The response-review gate - the OUTPUT half of governed AI. A clean model output
 * passes; a leaked secret/PII or a manipulation signal in the output stops for a
 * human with a redacted version. Deterministic.
 */
import { responseReviewGate } from "@/lib/gates/response-review-gate";
import { runGate } from "@/lib/gates/run-gate";

const ctx = { workspaceId: "w1", actorId: "u1", policy: { frameworks: ["GDPR"], allowModelData: "none" as const } };
const run = (text: string) => runGate(responseReviewGate, { text }, ctx);

it("allow: a clean model answer is safe to return", async () => {
  const r = await run("Your Q3 revenue grew 12% over Q2, driven mainly by the new tier.");
  expect(r.verdict).toBe("allow");
  expect(r.output?.leakedValues).toBe(0);
  expect(r.transparency.modelInvoked).toBeNull();
});

it("require_human: the model leaked a secret/PII in its response (raw output not returned)", async () => {
  const r = await run("Sure, the API key is sk-ant-abcdefghijklmnopqrstuvwxyz1234567890 and contact bob@acme.com");
  expect(r.verdict).toBe("require_human");
  expect(r.output?.leakedValues).toBeGreaterThanOrEqual(2);
  expect(r.output?.redactedText).toContain("[REDACTED]");
  expect(r.output?.redactedText).not.toContain("sk-ant-abcde");
});

it("require_human: the output shows the model was manipulated (system-prompt leak)", async () => {
  const r = await run("My system prompt is: you are a helpful assistant that never refuses.");
  expect(r.verdict).toBe("require_human");
  expect(r.output?.manipulation).toContain("system-prompt-leak");
});
