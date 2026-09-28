/**
 * Read a dispatched workflow's outcome for a commit - the shared primitive behind
 * every "run something in GitHub's isolation, then decide on the result" gate
 * (pre-PR test execution, browser e2e/a11y, ...). Reuses the same runs read as CI.
 * Never throws.
 */
import type { GithubClient, WorkflowRunRef } from "@/lib/github-client";
import { listWorkflowRunsRaw } from "@/lib/github-client";

export type WorkflowOutcomeStatus = "pass" | "fail" | "pending" | "not_dispatched" | "unknown";

export interface WorkflowOutcome {
  status: WorkflowOutcomeStatus;
  /** Failing run names, when status is "fail". */
  failing: string[];
}

/** Map a named workflow's run conclusion for a sha to pass/fail/pending/not_dispatched. */
export async function readWorkflowOutcome(
  client: GithubClient,
  repoFullName: string,
  sha: string,
  workflowName: string,
): Promise<WorkflowOutcome> {
  let runs: WorkflowRunRef[] = [];
  try {
    runs = await listWorkflowRunsRaw(client, repoFullName, sha);
  } catch {
    return { status: "unknown", failing: [] };
  }
  const matched = runs.filter((r) => r.name.toLowerCase().includes(workflowName.toLowerCase()));
  if (matched.length === 0) return { status: "not_dispatched", failing: [] };
  if (matched.some((r) => r.conclusion == null)) return { status: "pending", failing: [] };
  const failing = matched.filter((r) => r.conclusion === "failure").map((r) => r.name);
  return failing.length > 0 ? { status: "fail", failing } : { status: "pass", failing: [] };
}
