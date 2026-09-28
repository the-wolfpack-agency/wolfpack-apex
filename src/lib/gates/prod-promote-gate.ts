/**
 * prod-promote gate - the ONE intended human touchpoint.
 *
 * Everything before it is automated and verified (review -> auto-fix -> green CI
 * -> preview verified). This gate deliberately stops for a human: promoting to
 * PRODUCTION is a judgment a person owns. It always returns require_human,
 * carrying the preview evidence so the human decides with full context and the
 * fewest possible steps - approve, and the promotion proceeds.
 *
 * It is a gate (not just a UI button) so the STOP is itself audited and
 * transparent: the ledger records that the flow reached the human, with the
 * verified preview it is waiting on.
 */
import type { GateDefinition, GateResult } from "./types";

export interface ProdPromoteInput {
  /** The verified preview the human is being asked to promote. */
  previewUrl?: string;
  /** A short summary of what passed on the way here (for the human's context). */
  evidence?: string;
}

export interface ProdPromoteOutput {
  awaitingHumanFor: "production-promotion";
  previewUrl?: string;
}

export const prodPromoteGate: GateDefinition<ProdPromoteInput, ProdPromoteOutput> = {
  name: "prod-promote",
  entitlement: "secure_agent",
  purpose: "The single human touchpoint: promoting a verified preview to production. Always stops for a human, with the preview evidence, so approval is the only required step.",
  async evaluate(input, ctx): Promise<GateResult<ProdPromoteOutput>> {
    const reason = `Everything before production is automated and verified${input.previewUrl ? ` (preview: ${input.previewUrl})` : ""}. Promotion to production is the one decision a human owns - approve to proceed.`;
    return {
      verdict: "require_human",
      output: { awaitingHumanFor: "production-promotion", previewUrl: input.previewUrl },
      findings: [],
      reason,
      transparency: {
        checksRun: ["human-promotion-gate"],
        dataSeen: input.evidence ? `the verified-preview evidence: ${input.evidence}` : "the verified preview",
        modelInvoked: null,
        frameworksApplied: ctx.policy.frameworks,
        explanation: reason,
      },
      audit: { gate: "prod-promote", verdict: "require_human", ruleId: "GATE-prod-promote-human", reason, workspaceId: ctx.workspaceId, actorId: ctx.actorId },
    };
  },
};
