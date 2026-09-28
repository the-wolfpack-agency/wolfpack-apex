/**
 * Pre-PR validation - EXECUTE a change's own authored tests BEFORE a real PR is
 * opened, so a self-inconsistent artifact (a model authoring a test whose expected
 * value is wrong, code that does not compile, etc.) is caught at the source rather
 * than after a looping PR. Execution runs in GitHub's isolation via the
 * factory-validate workflow; this module is the app-side glue and is pure/testable
 * (all IO injected through the github client).
 *
 * Flow (orchestrated by the caller): push the authored change to a throwaway
 * validation branch (commitFileChanges), dispatch factory-validate, then poll
 * readValidationOutcome until it settles.
 */
import { createHash } from "node:crypto";
import type { GithubClient, WorkflowRunRef } from "@/lib/github-client";
import { listWorkflowRunsRaw, getBranchHead } from "@/lib/github-client";
import { commitFileChanges, filesToDiff, type FileChange } from "@/lib/ai-code/file-changes";

/** A throwaway branch name for validating a change before the real PR. Stable per
 *  (ref, content hash) so a retry reuses it. */
export function validationBranchName(ref: string, contentHash: string): string {
  const safeRef = ref.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40);
  return `factory-validate/${safeRef}-${contentHash.slice(0, 8)}`;
}

export type ValidationStatus = "pass" | "fail" | "pending" | "not_dispatched" | "unknown";

export interface ValidationOutcome {
  status: ValidationStatus;
  /** The failing validation run/check names, when status is "fail". */
  failing: string[];
}

/** Read the factory-validate run's conclusion for a commit. Reuses the same runs
 *  read as CI. Never throws. */
export async function readValidationOutcome(
  client: GithubClient,
  repoFullName: string,
  sha: string,
  workflowName = "factory-validate",
): Promise<ValidationOutcome> {
  let runs: WorkflowRunRef[] = [];
  try {
    runs = await listWorkflowRunsRaw(client, repoFullName, sha);
  } catch {
    return { status: "unknown", failing: [] };
  }
  const validate = runs.filter((r) => r.name.toLowerCase().includes(workflowName));
  if (validate.length === 0) return { status: "not_dispatched", failing: [] }; // no validate run for this sha yet
  // conclusion null => still running
  if (validate.some((r) => r.conclusion == null)) return { status: "pending", failing: [] };
  const failing = validate.filter((r) => r.conclusion === "failure").map((r) => r.name);
  return failing.length > 0 ? { status: "fail", failing } : { status: "pass", failing: [] };
}

/**
 * Push an authored change to a throwaway validation branch so factory-validate can
 * run its tests before a real PR exists. Idempotent: the branch is content-hashed,
 * and if it already exists (a re-poll), the existing branch is reused - the change
 * is pushed ONCE. Returns the branch name.
 */
export async function pushValidationBranch(
  client: GithubClient,
  repoFullName: string,
  changes: readonly FileChange[],
  base: string,
  ref: string,
): Promise<string> {
  const hash = createHash("sha256").update(filesToDiff(changes)).digest("hex");
  const branch = validationBranchName(ref, hash);
  const exists = await getBranchHead(client, repoFullName, branch).then(() => true).catch(() => false);
  if (!exists) {
    await commitFileChanges({ client, repoFullName, branch, base, changes: [...changes], message: `factory validate: ${ref}` });
  }
  return branch;
}
