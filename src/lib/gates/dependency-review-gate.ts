/**
 * dependency-review gate - a supply-chain checkpoint, near-free because it reuses
 * the SAME dependency detector the engineering invariants already use
 * (dependencyFactsFromDiff). A new runtime dependency is a last resort and a
 * supply-chain risk (new code, new maintainer, new attack surface), so adding one
 * stops for a human rather than sliding in unreviewed.
 *
 *   no new runtime dependency  -> allow
 *   a runtime dependency added -> require_human (a person reviews the addition:
 *                                 is it needed, trusted, and pinned?)
 *
 * Deterministic: no model. A removed/unchanged dep never blocks.
 */
import { dependencyFactsFromDiff } from "@/lib/ai-code/change-facts";
import type { GateDefinition, GateResult } from "./types";

export interface DependencyReviewInput {
  diff: string;
}

export interface DependencyReviewOutput {
  addedDependencies: string[];
  dependencyDelta: number;
}

export const dependencyReviewGate: GateDefinition<DependencyReviewInput, DependencyReviewOutput> = {
  name: "dependency-review",
  entitlement: "secure_agent",
  purpose: "Stop a change that adds a runtime dependency for a human to review (needed? trusted? pinned?) - a new dependency is a last resort and a supply-chain risk. Reuses the same detector as the engineering invariants.",
  async evaluate(input, ctx): Promise<GateResult<DependencyReviewOutput>> {
    const facts = dependencyFactsFromDiff(input.diff);
    const output = { addedDependencies: facts.addedDependencies, dependencyDelta: facts.dependencyDelta };

    if (facts.addedDependencies.length === 0) {
      return {
        verdict: "allow",
        output,
        findings: [],
        reason: "No new runtime dependency added.",
        transparency: { checksRun: ["package.json dependency delta"], dataSeen: "The diff's package.json dependency changes only. No model invoked.", modelInvoked: null, frameworksApplied: ctx.policy.frameworks, explanation: "No dependency added." },
        audit: { gate: "dependency-review", verdict: "allow", ruleId: "GATE-dependency-review-clean", reason: "no new dependency", workspaceId: ctx.workspaceId, actorId: ctx.actorId },
      };
    }

    const list = facts.addedDependencies.join(", ");
    const reason = `Adds ${facts.addedDependencies.length} runtime dependency(ies): ${list}. A new dependency is a last resort + a supply-chain risk; a human should confirm it is needed, trusted, and pinned before merge.`;
    return {
      verdict: "require_human",
      output,
      findings: facts.addedDependencies.map((d) => ({ id: "new-dependency", severity: "medium" as const, detail: `added runtime dependency: ${d}` })),
      reason,
      transparency: { checksRun: ["package.json dependency delta"], dataSeen: "The diff's package.json dependency changes only. No model invoked.", modelInvoked: null, frameworksApplied: ctx.policy.frameworks, explanation: reason },
      audit: { gate: "dependency-review", verdict: "require_human", ruleId: "GATE-dependency-review-added", reason, workspaceId: ctx.workspaceId, actorId: ctx.actorId },
    };
  },
};
