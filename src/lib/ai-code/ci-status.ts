/**
 * CI status for a factory PR, read back into Instinct.
 *
 * This is the producer for the dormant CI invariant: "a change may not reach a
 * human until CI is fully green" (OGIAM R-CI-INCOMPLETE-DENY). The summarizer is
 * pure over the check-run list, so it is trivially testable; the fetch is the
 * one GitHub call.
 *
 * "Fully passed" (ciComplete) is deliberately strict: at least one check ran,
 * every check has completed, and none failed. No checks yet -> NOT complete
 * (nothing verified is not the same as verified).
 */
import { listCheckRuns, workspaceGithubClient, type CheckRun, type GithubClient } from "@/lib/github-client";

/** Conclusions that count as a pass. Everything else that has a conclusion is a
 *  fail; a null conclusion means it has not finished. */
const PASSING = new Set(["success", "neutral", "skipped"]);

export interface CiSummary {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  /** Every check has completed (none queued / in_progress). */
  complete: boolean;
  /** Completed AND at least one check AND zero failures. Maps to ciComplete. */
  ciComplete: boolean;
  /** Names of the checks that failed, for a legible verdict. */
  failedChecks: string[];
  /** Failed checks with GitHub's output summary - the material a fixer acts on. */
  failedDetails: { name: string; summary: string }[];
}

/** Summarize a check-run list. Pure: no IO. */
export function summarizeChecks(checks: readonly CheckRun[]): CiSummary {
  let passed = 0;
  let failed = 0;
  let pending = 0;
  const failedChecks: string[] = [];
  const failedDetails: { name: string; summary: string }[] = [];
  for (const c of checks) {
    if (c.status !== "completed") {
      pending++;
      continue;
    }
    if (c.conclusion && PASSING.has(c.conclusion)) {
      passed++;
    } else {
      failed++;
      failedChecks.push(c.name);
      failedDetails.push({ name: c.name, summary: (c.output?.summary ?? "").slice(0, 2000) });
    }
  }
  const total = checks.length;
  const complete = total > 0 && pending === 0;
  return { total, passed, failed, pending, complete, ciComplete: complete && failed === 0, failedChecks, failedDetails };
}

/** Fetch + summarize a PR head ref's CI. Never throws: a GitHub error becomes an
 *  empty (not-complete) summary so a caller treats "cannot read CI" as "not
 *  verified", never as green. */
export async function fetchCiStatus(repoFullName: string, ref: string, workspaceId?: string): Promise<CiSummary> {
  try {
    const client: GithubClient = await workspaceGithubClient(workspaceId);
    if (!client.token) return summarizeChecks([]);
    const checks = await listCheckRuns(client, repoFullName, ref);
    return summarizeChecks(checks);
  } catch {
    return summarizeChecks([]);
  }
}
