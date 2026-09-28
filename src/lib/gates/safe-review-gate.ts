/**
 * safe-review gate - the simplest, purely-deterministic Agent Gate.
 *
 * A client runs their AI-authored change through it before merge: it reuses the
 * proven combined assessment (security scan + engineering invariants + deep
 * static scan) and returns a verdict. No code is generated; no model is invoked
 * (modelInvoked is always null), so it is the strongest "adopt one gate safely"
 * story - a client under strict data rules can run it with allowModelData: none
 * and nothing ever leaves their boundary.
 *
 * Verdict mapping:
 *   handoffAllowed            -> allow          (clears every layer)
 *   security block / deep-scan-> deny           (hard stop: secret, injection, critical)
 *   otherwise (invariant)     -> require_human   (a person should look)
 * It never auto-fixes - it is a guard, not an author.
 */
import { assessChange, type ChangeAssessment } from "@/lib/ai-code/assess";
import type { GateDefinition, GateResult, GateFinding } from "./types";

export interface SafeReviewInput {
  /** The unified diff to assess. */
  diff: string;
}

/** The change carried forward on allow, so this gate can chain into a fix/deploy
 *  gate without re-supplying the diff. */
export interface SafeReviewOutput {
  diff: string;
  assessment: ChangeAssessment;
}

function findingsFor(a: ChangeAssessment): GateFinding[] {
  const out: GateFinding[] = [];
  if (a.securityOutcome !== "allow") out.push({ id: "security", severity: a.securityOutcome === "block" ? "critical" : "high", detail: `security scan: ${a.securityOutcome}` });
  if (a.invariantBlocked) out.push({ id: "invariant", severity: "high", detail: `engineering invariant blocked: ${a.invariantRuleId}` });
  if (a.deepScanCritical > 0) out.push({ id: "deep-scan", severity: "critical", detail: `${a.deepScanCritical} critical finding(s) in deep static scan` });
  return out;
}

export const safeReviewGate: GateDefinition<SafeReviewInput, SafeReviewOutput> = {
  name: "safe-review",
  entitlement: "secure_agent",
  purpose: "Deterministically screen an AI-authored change (secrets, injection, unsafe patterns, engineering invariants) before it reaches a human or the next gate.",
  async evaluate(input, ctx): Promise<GateResult<SafeReviewOutput>> {
    const a = await assessChange(input.diff);
    const verdict = a.handoffAllowed
      ? "allow"
      : a.securityOutcome === "block" || a.deepScanBlocking
        ? "deny"
        : "require_human";
    const reason = a.handoffAllowed
      ? "Every deterministic layer cleared the change."
      : `Stopped by ${a.blockedBy}: ${a.blockedBy === "security" ? `security scan ${a.securityOutcome}` : a.blockedBy === "deep-scan" ? `${a.deepScanCritical} critical finding(s)` : `engineering invariant ${a.invariantRuleId}`}.`;
    return {
      verdict,
      output: verdict === "allow" ? { diff: input.diff, assessment: a } : undefined,
      findings: findingsFor(a),
      reason,
      transparency: {
        checksRun: ["security-scan", "engineering-invariants", "deep-static-scan"],
        dataSeen: "The unified diff only. Nothing was sent to any model (deterministic gate).",
        modelInvoked: null,
        frameworksApplied: ctx.policy.frameworks, // stamped by runGate too; set here for standalone use
        explanation: reason,
      },
      audit: { gate: "safe-review", verdict, ruleId: `GATE-safe-review-${a.blockedBy ?? "allow"}`, reason, workspaceId: ctx.workspaceId, actorId: ctx.actorId },
    };
  },
};
