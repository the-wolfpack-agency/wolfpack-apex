/**
 * Flake pre-filter: a failing check is only a real, fixable failure if it fails
 * AGAIN on a re-run. Before the fixer authors anything on the first attempt, we
 * re-run the failed jobs ONCE; a flake clears, a real failure survives (its
 * run_attempt reaches 2) and only then do we author. This stops the fixer from
 * "fixing" a non-deterministic test - wasting an attempt or, worse, corrupting
 * the source to chase a flake.
 *
 * Cost is bounded: only on the FIRST attempt (before any fix commit), and only
 * once per run (the run_attempt < 2 gate), so a PR pays at most one extra CI
 * cycle to rule out flakes.
 */
import type { WorkflowRunRef } from "@/lib/github-client";

/** The ids of failing runs (optionally scoped to the INTRODUCED ones) that are
 *  still on their first attempt - candidates to re-run once to rule out a flake.
 *  Pure. */
export function flakeRecheckCandidates(
  runs: readonly WorkflowRunRef[],
  onlyRunNames?: readonly string[],
): number[] {
  const scope = onlyRunNames && onlyRunNames.length > 0 ? new Set(onlyRunNames) : null;
  return runs
    .filter((r) => r.conclusion === "failure" && r.runAttempt < 2 && (!scope || scope.has(r.name)))
    .map((r) => r.id);
}
