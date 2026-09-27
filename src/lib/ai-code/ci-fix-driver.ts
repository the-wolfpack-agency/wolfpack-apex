/**
 * The post-PR CI fix loop, closed. ci-fix-loop.ts DECIDES the next action from a
 * CI status; this DRIVER performs it: on a red CI with budget left, it re-authors
 * the fix and commits it to the PR branch (which re-triggers CI), so a caller
 * that polls this until it returns terminal drives the PR to green or to a human.
 *
 * Pure orchestration over injected effects (reauthor + commit), so it is fully
 * testable without a model or GitHub. The route wires the real ones. Never loops
 * forever: the decision is bounded by maxAttempts, and a re-author that produces
 * nothing usable escalates to a human rather than spinning.
 */
import type { CiSummary } from "./ci-status";
import { decideFixAction, buildFixBrief, type FixDecision } from "./ci-fix-loop";
import type { FileChange } from "./file-changes";

export interface CiFixStepResult {
  decision: FixDecision;
  ci: CiSummary;
  /** Present only when a fix was authored + committed this step. */
  fix?: { author: string; files: string[]; brief: string };
  /** True when the caller should STOP polling (green, escalated, or unfixable). */
  terminal: boolean;
}

export async function runCiFixStep(args: {
  ci: CiSummary;
  attempt: number;
  maxAttempts: number;
  /** Re-author a fix for the failing checks. Route to a DIFFERENT lineage than
   *  the original author for independence. Returns full-file changes. */
  reauthor: (brief: string) => Promise<{ changes: FileChange[]; author: string; error: string | null }>;
  /** Commit the authored files to the PR branch. Returns committed paths. */
  commit: (changes: FileChange[]) => Promise<string[]>;
}): Promise<CiFixStepResult> {
  const decision = decideFixAction({ ci: args.ci, attempt: args.attempt, maxAttempts: args.maxAttempts });

  // Only author_fix does work. merge_ready / escalate_human are terminal; wait is
  // non-terminal (poll again) but changes nothing.
  if (decision.action !== "author_fix") {
    return {
      decision,
      ci: args.ci,
      terminal: decision.action === "merge_ready" || decision.action === "escalate_human",
    };
  }

  const brief = buildFixBrief(args.ci.failedDetails);
  const authored = await args.reauthor(brief);
  if (authored.error || authored.changes.length === 0) {
    return {
      decision: { action: "escalate_human", reason: `re-author produced no fix (${authored.error ?? "empty"})` },
      ci: args.ci,
      terminal: true,
    };
  }

  const files = await args.commit(authored.changes);
  // The commit pushes the branch, so CI re-runs; the next poll re-evaluates. Not
  // terminal: the caller polls again to see whether this fix turned CI green.
  return { decision, ci: args.ci, fix: { author: authored.author, files, brief }, terminal: false };
}
