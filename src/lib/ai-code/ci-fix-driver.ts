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
  /** The gate verdict on the re-authored fix, when a gate was supplied. A blocked
   *  fix is NEVER committed; it escalates to a human instead. */
  gate?: { cleared: boolean; blockedBy: string | null };
  /** True when the caller should STOP polling (green, escalated, or unfixable). */
  terminal: boolean;
}

export async function runCiFixStep(args: {
  ci: CiSummary;
  attempt: number;
  maxAttempts: number;
  /** Baseline attribution: how many failing checks the change INTRODUCED. When
   *  zero, the fixer does not author (the red is pre-existing). Threaded to the
   *  deterministic decision. */
  introducedFailing?: number;
  /** Set when the failure is a governance/policy gate - the decision escalates to
   *  a human instead of authoring a mechanical fix. */
  governanceFailure?: { signal: string };
  /** The failed-check details to brief the re-author with. Defaults to every
   *  failing check; the route narrows this to only the INTRODUCED checks so the
   *  fixer never tries to repair pre-existing red. */
  briefDetails?: readonly { name: string; summary: string }[];
  /** Re-author a fix for the failing checks. Route to a DIFFERENT lineage than
   *  the original author for independence. Returns full-file changes. */
  reauthor: (brief: string) => Promise<{ changes: FileChange[]; author: string; error: string | null }>;
  /** Commit the authored files to the PR branch. Returns committed paths. */
  commit: (changes: FileChange[]) => Promise<string[]>;
  /** Gate the re-authored fix BEFORE it is committed. A fix that does not clear
   *  the gate (a secret, an injection, a critical finding) is never pushed to the
   *  PR branch; it escalates to a human. Optional so the driver stays testable,
   *  but the route always supplies the real combined gate. */
  gate?: (changes: FileChange[]) => Promise<{ cleared: boolean; blockedBy: string | null }>;
}): Promise<CiFixStepResult> {
  const decision = decideFixAction({ ci: args.ci, attempt: args.attempt, maxAttempts: args.maxAttempts, introducedFailing: args.introducedFailing, governanceFailure: args.governanceFailure });

  // Only author_fix does work. merge_ready / escalate_human are terminal; wait is
  // non-terminal (poll again) but changes nothing.
  if (decision.action !== "author_fix") {
    return {
      decision,
      ci: args.ci,
      terminal: decision.action === "merge_ready" || decision.action === "escalate_human",
    };
  }

  const brief = buildFixBrief(args.briefDetails ?? args.ci.failedDetails);
  const authored = await args.reauthor(brief);
  if (authored.error || authored.changes.length === 0) {
    return {
      decision: { action: "escalate_human", reason: `re-author produced no fix (${authored.error ?? "empty"})` },
      ci: args.ci,
      terminal: true,
    };
  }

  // Gate the fix BEFORE committing. An autonomous fixer must clear the SAME
  // deterministic gate as the front door: a fix that introduces a secret,
  // injection, or critical finding is never pushed to the PR branch. It escalates
  // to a human instead. This is the "behind its gate" guarantee for the loop.
  if (args.gate) {
    const gate = await args.gate(authored.changes);
    if (!gate.cleared) {
      return {
        decision: {
          action: "escalate_human",
          reason: `the re-authored fix did not pass the gate${gate.blockedBy ? ` (blocked by ${gate.blockedBy})` : ""}; it was NOT committed`,
        },
        ci: args.ci,
        gate,
        terminal: true,
      };
    }
  }

  const files = await args.commit(authored.changes);
  // The commit pushes the branch, so CI re-runs; the next poll re-evaluates. Not
  // terminal: the caller polls again to see whether this fix turned CI green.
  return {
    decision,
    ci: args.ci,
    fix: { author: authored.author, files, brief },
    ...(args.gate ? { gate: { cleared: true, blockedBy: null } } : {}),
    terminal: false,
  };
}
