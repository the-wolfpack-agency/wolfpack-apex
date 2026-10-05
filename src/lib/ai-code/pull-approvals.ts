/**
 * The read model behind the Code Factory's in-tool approval surface: list the
 * workspace's OPEN factory PRs with everything a human needs to approve a merge
 * from the tool - the PR link, whether CI is green, the gate verdict, and whether
 * it meets the same auto-merge ELIGIBILITY policy used everywhere else.
 *
 * Reuses the exact primitives the gate/auto-merge path uses (listOpenPullRequests,
 * fetchCiStatus, reviewDiff + decideCodeGate, touchesSecuritySurface, isTestPath,
 * autoMergeEligible) so "eligible here" means the identical thing it means there.
 * No new policy. Each PR's status is computed independently; a per-PR failure
 * degrades that row (gateOutcome:"unknown", eligible:false), never the whole list.
 */
import { type GithubClient, listOpenPullRequests, listChangedFiles } from "@/lib/github-client";
import { fetchCiStatus } from "./ci-status";
import { fetchFilesContent } from "./ci-failure-detail";
import { filesToDiff } from "./file-changes";
import { reviewDiff } from "./detect";
import { decideCodeGate } from "./gate";
import { touchesSecuritySurface } from "./security-surface";
import { isTestPath } from "./reuse-enforcement";
import { autoMergeEligible } from "./auto-merge";
import { isFactoryBranch } from "./revert";

/** A PR larger than this is never auto-eligible (a human authorizes a big diff),
 *  and bounds the gate re-scan cost per PR. */
export const MAX_APPROVAL_SCAN_FILES = 25;

export type GateOutcome = "allow" | "escalate" | "block" | "unknown";

export interface PullApprovalStatus {
  repo: string;
  number: number;
  title: string;
  url: string;
  branch: string;
  base: string;
  /** Every required check green (ciComplete). */
  ciGreen: boolean;
  /** CI could be read at all (false => unknown, shown as such, never "green"). */
  ciReadable: boolean;
  gateOutcome: GateOutcome;
  touchesSensitiveSurface: boolean;
  hasTests: boolean;
  fileCount: number;
  /** Meets the auto-merge policy (CI green + gate allow + no sensitive surface + tests). */
  eligible: boolean;
  eligibilityReason: string;
}

/** Compute the approval status of ONE open PR. Never throws: any IO failure
 *  degrades the row to a conservative not-eligible state. */
export async function pullApprovalStatus(
  client: GithubClient,
  repo: string,
  pr: { number: number; headRef: string; baseRef: string; title: string },
  workspaceId?: string,
): Promise<PullApprovalStatus> {
  const base = pr.baseRef || "main";
  const url = `https://github.com/${repo}/pull/${pr.number}`;
  let ciGreen = false;
  let ciReadable = true;
  let gateOutcome: GateOutcome = "unknown";
  let touchesSensitiveSurface = false;
  let hasTests = false;
  let fileCount = 0;

  try {
    const ci = await fetchCiStatus(repo, pr.headRef, workspaceId);
    ciReadable = ci.readable !== false;
    ciGreen = ci.ciComplete === true;
  } catch {
    ciReadable = false;
  }

  try {
    const files = await listChangedFiles(client, repo, base, pr.headRef);
    fileCount = files.length;
    touchesSensitiveSurface = touchesSecuritySurface(files).length > 0;
    hasTests = files.some((f) => isTestPath(f));
    if (files.length > 0 && files.length <= MAX_APPROVAL_SCAN_FILES) {
      const contents = await fetchFilesContent(client, repo, files, pr.headRef, {
        maxFiles: MAX_APPROVAL_SCAN_FILES,
        maxCharsPerFile: 20_000,
      });
      gateOutcome = decideCodeGate(reviewDiff(filesToDiff(contents))).outcome as GateOutcome;
    }
    // A diff too large to scan is never auto-eligible (gateOutcome stays "unknown").
  } catch {
    gateOutcome = "unknown";
  }

  const decision = autoMergeEligible({
    ciGreen,
    gateOutcome: gateOutcome === "unknown" ? "escalate" : gateOutcome,
    touchesSensitiveSurface,
    hasTests,
  });

  return {
    repo,
    number: pr.number,
    title: pr.title,
    url,
    branch: pr.headRef,
    base,
    ciGreen,
    ciReadable,
    gateOutcome,
    touchesSensitiveSurface,
    hasTests,
    fileCount,
    eligible: decision.eligible,
    eligibilityReason: decision.reason,
  };
}

/** List the workspace's open FACTORY PRs with their approval status. Non-factory
 *  PRs (hand-authored branches) are excluded - this surface governs the factory's
 *  own output. Each row is computed independently and concurrently. */
export async function listFactoryPullStatuses(
  client: GithubClient,
  repo: string,
  workspaceId?: string,
): Promise<PullApprovalStatus[]> {
  const open = await listOpenPullRequests(client, repo);
  const factory = open.filter((p) => isFactoryBranch(p.headRef));
  return Promise.all(factory.map((p) => pullApprovalStatus(client, repo, p, workspaceId)));
}
