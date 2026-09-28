/**
 * data-egress gate - the platform's generality proof, and the "don't leak data to
 * the LLM" promise as a STANDALONE gate any AI workflow can adopt (not just code).
 *
 * A client sends arbitrary text bound for a model or an external service; the gate
 * deterministically detects secrets and PII, and either clears it (nothing
 * sensitive) or stops for a human with the REDACTED version ready to use. It runs
 * on the SAME gate runtime as the code gates - same verdicts, same hash-chained
 * audit, same client-facing transparency, model-agnostic - which is the point:
 * the Agent Gate is a general governed checkpoint, and code review is just one
 * app on it.
 *
 *   no sensitive data     -> allow          (safe to send as-is)
 *   secrets/PII detected   -> require_human   (a person confirms, or uses the
 *                                             redacted output the gate returns)
 *
 * Deterministic: no model is ever invoked (the whole point is to decide BEFORE
 * anything reaches one).
 */
import { scrubForModel } from "./scrub";
import type { GateDefinition, GateResult } from "./types";

export interface DataEgressInput {
  /** The text about to leave for a model / external service. */
  text: string;
  /** Optional label for where it is going (surfaced in transparency). */
  destination?: string;
}

export interface DataEgressOutput {
  /** The text with secrets/PII redacted - safe to send if the human approves. */
  redactedText: string;
  redactions: number;
}

export const dataEgressGate: GateDefinition<DataEgressInput, DataEgressOutput> = {
  name: "data-egress",
  entitlement: "secure_agent",
  purpose: "Screen text bound for a model or external service: detect secrets + PII deterministically and either clear it or stop for a human with a redacted version - so a client's data never leaves by accident.",
  async evaluate(input, ctx): Promise<GateResult<DataEgressOutput>> {
    const scrub = scrubForModel(input.text);
    const dest = input.destination ? ` to ${input.destination}` : "";
    const dataSeen = `The supplied text (${input.text.length} chars). No model invoked; sensitive values are redacted in the output.`;

    if (scrub.count === 0) {
      return {
        verdict: "allow",
        output: { redactedText: input.text, redactions: 0 },
        findings: [],
        reason: `No secrets or PII detected; the data is safe to send${dest}.`,
        transparency: { checksRun: ["secret-scan", "pii-scan"], dataSeen, modelInvoked: null, frameworksApplied: ctx.policy.frameworks, explanation: `No sensitive data found.` },
        audit: { gate: "data-egress", verdict: "allow", ruleId: "GATE-data-egress-clean", reason: "no sensitive data", workspaceId: ctx.workspaceId, actorId: ctx.actorId },
      };
    }

    const reason = `${scrub.count} sensitive value(s) (secret/PII) detected in data bound${dest || " for a model / external service"}. Stopping for a human: confirm it should be sent, or use the redacted version this gate returned. It was NOT auto-sent.`;
    return {
      verdict: "require_human",
      output: { redactedText: scrub.text, redactions: scrub.count },
      findings: [{ id: "sensitive-data", severity: "high", detail: `${scrub.count} secret/PII value(s) found` }],
      reason,
      transparency: { checksRun: ["secret-scan", "pii-scan"], dataSeen, modelInvoked: null, frameworksApplied: ctx.policy.frameworks, explanation: reason },
      audit: { gate: "data-egress", verdict: "require_human", ruleId: "GATE-data-egress-sensitive", reason, workspaceId: ctx.workspaceId, actorId: ctx.actorId },
    };
  },
};
