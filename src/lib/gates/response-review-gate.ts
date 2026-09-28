/**
 * response-review gate - the OUTPUT half of governed AI (data-egress is the input
 * half). A model's response can leak a secret / PII it saw in its context, or
 * reveal it was manipulated (echoing its system prompt, "I have ignored...", a
 * jailbreak confirmation). This gate screens the model's OUTPUT before it reaches
 * a user or a downstream action - deterministically, no second model needed.
 *
 *   clean output                        -> allow (safe to return, as-is)
 *   leaked secret/PII, or manipulation   -> require_human (with the leaked values
 *     signal in the output               redacted; the raw output is NOT returned)
 *
 * Closes the symmetry: govern what goes TO the model AND what comes BACK.
 */
import { scrubForModel } from "./scrub";
import type { GateDefinition, GateResult } from "./types";

/** Signs, in the model's OUTPUT, that it was manipulated / leaked its own setup. */
const MANIPULATION_PATTERNS: { id: string; re: RegExp }[] = [
  { id: "system-prompt-leak", re: /\b(?:my|the)\s+(?:system\s+prompt|initial\s+instructions?|system\s+message)\s+(?:is|are|says|:)/i },
  { id: "injection-confirmed", re: /\bI (?:have|will) (?:now )?(?:ignore|disregard|bypass)(?:d|ed)?\b.*\b(?:instructions?|rules?|guardrails?|restrictions?)/i },
  { id: "jailbreak-persona", re: /\b(?:as (?:DAN|an unrestricted AI|your jailbroken)|developer mode enabled)\b/i },
];

export interface ResponseReviewInput {
  /** The model's response, about to be shown to a user / used downstream. */
  text: string;
}

export interface ResponseReviewOutput {
  redactedText: string;
  leakedValues: number;
  manipulation: string[];
}

export const responseReviewGate: GateDefinition<ResponseReviewInput, ResponseReviewOutput> = {
  name: "response-review",
  entitlement: "secure_agent",
  purpose: "Screen a model's OUTPUT before it reaches a user: catch a leaked secret/PII the model regurgitated, or signs it was manipulated (system-prompt leak, injection confirmation) - deterministically, no second model.",
  async evaluate(input, ctx): Promise<GateResult<ResponseReviewOutput>> {
    const scrub = scrubForModel(input.text);
    const manipulation = MANIPULATION_PATTERNS.filter((p) => p.re.test(input.text)).map((p) => p.id);
    const output = { redactedText: scrub.text, leakedValues: scrub.count, manipulation };
    const dataSeen = `The model's response (${input.text.length} chars). No second model invoked.`;
    const checks = ["secret/PII-in-output", "manipulation-signals"];

    if (scrub.count === 0 && manipulation.length === 0) {
      return {
        verdict: "allow",
        output,
        findings: [],
        reason: "The model's output is clean - no leaked secret/PII, no sign of manipulation. Safe to return.",
        transparency: { checksRun: checks, dataSeen, modelInvoked: null, frameworksApplied: ctx.policy.frameworks, explanation: "Clean output." },
        audit: { gate: "response-review", verdict: "allow", ruleId: "GATE-response-review-clean", reason: "clean output", workspaceId: ctx.workspaceId, actorId: ctx.actorId },
      };
    }

    const parts: string[] = [];
    if (scrub.count > 0) parts.push(`${scrub.count} secret/PII value(s) leaked in the response`);
    if (manipulation.length > 0) parts.push(`manipulation signal(s): ${manipulation.join(", ")}`);
    const reason = `The model's output is unsafe to return as-is: ${parts.join("; ")}. Stopping for a human; the raw output was NOT returned (a redacted version is provided).`;
    return {
      verdict: "require_human",
      output,
      findings: [
        ...(scrub.count > 0 ? [{ id: "output-data-leak", severity: "high" as const, detail: `${scrub.count} secret/PII value(s) in the response` }] : []),
        ...manipulation.map((id) => ({ id, severity: "high" as const, detail: `manipulation in output: ${id}` })),
      ],
      reason,
      transparency: { checksRun: checks, dataSeen, modelInvoked: null, frameworksApplied: ctx.policy.frameworks, explanation: reason },
      audit: { gate: "response-review", verdict: "require_human", ruleId: "GATE-response-review-unsafe", reason, workspaceId: ctx.workspaceId, actorId: ctx.actorId },
    };
  },
};
