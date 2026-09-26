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
}

/**
 * Decide the next step from the current CI state. Pure and total:
 *  - CI fully green            -> merge_ready (a human still approves the merge)
 *  - CI still running          -> wait (poll again; do not author on a moving target)
 *  - CI failed, budget left    -> author_fix (feed the failures to the executor)
 *  - CI failed, budget spent   -> escalate_human (never loop forever)
 */
export function decideFixAction(state: FixLoopState): FixDecision {
  if (state.ci.ciComplete) {
    return { action: "merge_ready", reason: "CI is fully green; ready for the human merge approval" };
  }
  if (!state.ci.complete) {
    return { action: "wait", reason: `CI still running (${state.ci.pending} check(s) pending)` };
  }
  // complete but not green => there are failures.
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
