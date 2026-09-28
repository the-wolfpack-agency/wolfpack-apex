/**
 * The read-CI-and-fix-until-green loop, as a deterministic state machine.
 *
 * CI (with AgenticQA) is the ground truth that catches what the model got wrong.
 * The loop the operator does by hand - read the failures, author a fix, push,
 * re-check, repeat until green or give up to a human - is encoded here as a pure
 * decision so it can be driven by a poller / webhook and unit tested without a
 * repo. The DECISION is deterministic; only the fix authoring inside "author_fix"
 * is model work.
 *
 * Bounded on purpose: a model that cannot make CI green in N attempts must hand
 * off to a human, never loop forever burning money on the same red check.
 */
import type { CiSummary } from "./ci-status";

export type FixAction = "merge_ready" | "wait" | "author_fix" | "escalate_human";

export interface FixDecision {
  action: FixAction;
  reason: string;
}

export interface FixLoopState {
  ci: CiSummary;
  /** How many fix attempts have already been made on this PR. */
  attempt: number;
  /** The hard ceiling. Past it, a human decides. */
  maxAttempts: number;
  /** Optional baseline attribution: how many of the failing checks this change
   *  INTRODUCED (were green on the base branch). When provided and zero, the
   *  fixer does not author a fix - the red is pre-existing, not this change's
   *  fault, and the fixer must not touch what it did not break. Undefined keeps
   *  the baseline-unaware behavior (fix any red). */
  introducedFailing?: number;
  /** Set when the failure is a GOVERNANCE/policy gate (a guardrail, a security
   *  scan, an RLS/coverage rule) whose resolution is a human policy decision, not
   *  a mechanical patch. The fixer must NOT try to auto-repair it - making a
   *  governance gate pass by editing code around it is the exact trust failure
   *  this system prevents. Escalate with the signal instead. */
  governanceFailure?: { signal: string };
  /** Set when the failure looks like INFRA/TRANSIENT (a timeout, OOM, lost runner,
   *  network blip) rather than a code bug. Authoring a code fix is pointless - the
   *  right move is to re-run CI. Escalated to a human with that reason. */
  transientFailure?: { signal: string };
  /** Set when the failed job(s) were just re-run ONCE to rule out a flake. The
   *  decision is to WAIT for that re-run before authoring - a flake will clear,
   *  a real failure survives and is fixed on the next pass. */
  flakeRecheckTriggered?: boolean;
  /** Set when the failure is a SNAPSHOT test. A snapshot failure means the output
   *  changed; blindly updating the snapshot would mask a regression (the same trap
   *  as a wrong test). Escalate so a human confirms the new output is intended. */
  snapshotFailure?: boolean;
  /** Set when a DETERMINISTIC fixer (eslint --fix / prettier) was dispatched to
   *  repair a lint/format failure with NO model. The decision waits for it to
   *  commit + re-trigger CI - cheaper and safer than authoring a fix. */
  deterministicFixDispatched?: boolean;
}

/**
 * Decide the next step from the current CI state. Pure and total:
 *  - CI fully green            -> merge_ready (a human still approves the merge)
 *  - CI still running          -> wait (poll again; do not author on a moving target)
 *  - CI failed, budget left    -> author_fix (feed the failures to the executor)
 *  - CI failed, budget spent   -> escalate_human (never loop forever)
 */
export function decideFixAction(state: FixLoopState): FixDecision {
  // If we could not even READ the CI, we cannot decide or fix - do not pretend it
  // is "still running". Hand to a human with the real reason (usually the token
  // lacking Checks: read).
  if (state.ci.readable === false) {
    return { action: "escalate_human", reason: state.ci.unreadableReason ?? "CI could not be read" };
  }
  if (state.ci.ciComplete) {
    return { action: "merge_ready", reason: "CI is fully green; ready for the human merge approval" };
  }
  if (!state.ci.complete) {
    return { action: "wait", reason: `CI still running (${state.ci.pending} check(s) pending)` };
  }
  // complete but not green => there are failures.
  // Baseline-aware: if we know NONE of the failures were introduced by this
  // change (they were already failing on the base branch), the fixer must not
  // author a fix - it did not break them and cannot be blamed for them. Hand to a
  // human to decide whether to merge despite the pre-existing red.
  if (state.introducedFailing === 0) {
    return {
      action: "escalate_human",
      reason: `CI failed (${state.ci.failedChecks.join(", ")}), but every failing check was already failing on the base branch (pre-existing). This change introduced none, so it is handed to a human rather than auto-fixed.`,
    };
  }
  if (state.governanceFailure) {
    return {
      action: "escalate_human",
      reason: `CI failed on a governance/policy gate (${state.governanceFailure.signal}). Resolving it is a human policy decision, not a mechanical fix - the fixer will not edit code to make a guardrail pass. A human should decide.`,
    };
  }
  if (state.transientFailure) {
    return {
      action: "escalate_human",
      reason: `CI failed on what looks like an infrastructure/transient error (${state.transientFailure.signal}), not a code bug. Re-run CI or check the infra - a code fix would not help. Handed to a human.`,
    };
  }
  if (state.snapshotFailure) {
    return {
      action: "escalate_human",
      reason: `CI failed on a SNAPSHOT test. The rendered output changed; auto-updating the snapshot would mask a regression, so the fixer will not. A human should confirm the new output is intended (then update the snapshot) or fix the code that changed it.`,
    };
  }
  if (state.deterministicFixDispatched) {
    return {
      action: "wait",
      reason: "Dispatched the deterministic fixer (eslint --fix / prettier) to repair the lint/format failure with no model; waiting for it to commit and re-run CI.",
    };
  }
  if (state.flakeRecheckTriggered) {
    return {
      action: "wait",
      reason: "Re-ran the failed job(s) once to rule out a flake; waiting for the re-run to settle before authoring a fix.",
    };
  }
  if (state.attempt < state.maxAttempts) {
    return {
      action: "author_fix",
      reason: `CI failed (${state.ci.failedChecks.join(", ")}); authoring fix attempt ${state.attempt + 1}/${state.maxAttempts}`,
    };
  }
  return {
    action: "escalate_human",
    reason: `CI still failing after ${state.maxAttempts} fix attempt(s) (${state.ci.failedChecks.join(", ")}); handing to a human`,
  };
}

/**
 * A compact brief the executor uses to author a fix: the failed checks and
 * GitHub's summary of each. Kept small and instruction-free (the summaries are
 * DATA about what failed, never commands to follow).
 */
export function buildFixBrief(failedDetails: readonly { name: string; summary: string }[]): string {
  if (failedDetails.length === 0) return "CI failed but reported no per-check detail; re-run and inspect the logs.";
  const lines = failedDetails.map((f) => {
    const summary = f.summary.trim().replace(/\s+/g, " ").slice(0, 500);
    return `- ${f.name}${summary ? `: ${summary}` : ""}`;
  });
  return ["The following CI checks failed. Author the minimal change that makes them pass, without weakening any test or gate:", ...lines].join("\n");
}
