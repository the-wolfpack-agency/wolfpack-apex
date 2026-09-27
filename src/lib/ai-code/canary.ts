/**
 * Deterministic canary decision for a factory PR's autonomous fix.
 *
 * After the fixer commits a change the branch redeploys, and a CANARY (the
 * "Build & deploy" checkpoint) tells us whether the new commit is safe. This
 * decides, with NO model, what to do next:
 *
 *   - deploy PASSED  -> promote (the fix is good; keep it, and it becomes the new
 *                       last-good checkpoint)
 *   - deploy FAILED  -> revert to the last-good SHA, when we have one that differs
 *                       from the current head (never a no-op reset). With no safe
 *                       checkpoint, HOLD for a human rather than reset to nothing.
 *   - deploy PENDING / absent -> hold (canary still running; poll again)
 *
 * The revert target is the LAST-GOOD commit - the human-approved checkpoint, or
 * the last commit whose canary passed - never main. Reverting undoes the agent's
 * change without discarding the human-approved work. Pure: same inputs, same
 * decision, so it is trivially testable and the auto-revert path is auditable.
 */
export type CanaryStatus = "pass" | "fail" | "pending" | "absent";
export type CanaryAction = "promote" | "revert" | "hold";

export interface CanaryDecision {
  action: CanaryAction;
  /** The SHA to act on: the promote target (current) or the revert target
   *  (last-good). null when holding. */
  toSha: string | null;
  reason: string;
}

export function decideCanaryAction(args: {
  deploy: CanaryStatus;
  currentSha: string;
  lastGoodSha: string | null;
}): CanaryDecision {
  if (args.deploy === "fail") {
    if (args.lastGoodSha && args.lastGoodSha !== args.currentSha) {
      return {
        action: "revert",
        toSha: args.lastGoodSha,
        reason: "the canary deploy failed; reverting to the last-good version",
      };
    }
    return {
      action: "hold",
      toSha: null,
      reason:
        "the canary deploy failed but there is no last-good checkpoint to revert to; held for a human",
    };
  }
  if (args.deploy === "pass") {
    return {
      action: "promote",
      toSha: args.currentSha,
      reason: "the canary deploy passed; the change is promoted and is the new last-good version",
    };
  }
  return { action: "hold", toSha: null, reason: "the canary deploy has not finished; holding" };
}
