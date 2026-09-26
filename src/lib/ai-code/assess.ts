/**
 * The combined pre-PR assessment: run a change through ALL deterministic gate
 * layers at once and return the single handoff decision. This is the exact
 * condition the pipeline uses to hand off (security gate allows AND no invariant
 * blocks AND the deep scan is clean), extracted so it can be proven as one thing
 * over a corpus - and reused rather than re-expressed.
 *
 * Deterministic: no model. Same change in, same decision out. The model authors;
 * THIS decides whether what it authored may reach a human.
 */
import { reviewDiff } from "./detect";
import { decideCodeGate } from "./gate";
import { evaluateChangeInvariants, type ChangeInvariantInput } from "./change-facts";
import { deepScanChange } from "./deep-scan";

export interface ChangeAssessment {
  securityOutcome: "allow" | "escalate" | "block";
  invariantRuleId: string;
  invariantBlocked: boolean;
  deepScanCritical: number;
  deepScanBlocking: boolean;
  /** True only when every layer clears the change for human handoff. */
  handoffAllowed: boolean;
  /** Which layer stopped it (first that applies), or null when allowed. */
  blockedBy: "security" | "invariant" | "deep-scan" | null;
}

export async function assessChange(diff: string, opts: ChangeInvariantInput = {}): Promise<ChangeAssessment> {
  const security = decideCodeGate(reviewDiff(diff));
  const { decision: inv } = evaluateChangeInvariants(diff, opts);
  const deep = await deepScanChange(diff);

  const securityBlocked = security.outcome !== "allow";
  const handoffAllowed = !securityBlocked && !inv.wouldBlock && !deep.blocking;
  const blockedBy = securityBlocked ? "security" : inv.wouldBlock ? "invariant" : deep.blocking ? "deep-scan" : null;

  return {
    securityOutcome: security.outcome,
    invariantRuleId: inv.ruleId,
    invariantBlocked: inv.wouldBlock,
    deepScanCritical: deep.critical,
    deepScanBlocking: deep.blocking,
    handoffAllowed,
    blockedBy,
  };
}
