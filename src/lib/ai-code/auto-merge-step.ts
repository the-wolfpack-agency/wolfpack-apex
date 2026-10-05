/**
 * maybeAutoMerge - the EFFECT side of factory auto-merge, called at the ci-fix
 * loop's merge_ready point (where it otherwise stops for a human). Dark by default
 * (autoMergeEnabled). Conservative: it enables native GitHub auto-merge ONLY for
 * the low-risk tail - a SMALL change, gate verdict = allow, no sensitive surface,
 * tests present. Everything else keeps the human merge gate. Fail-open: any error
 * returns {attempted:false} and never throws into the runner's hot path.
 *
 * Keeps the policy file (auto-merge.ts) pure - this is the IO orchestration that
 * gathers the signals (from the live PR) and feeds the pure autoMergeEligible.
 */
import { autoMergeEnabled, autoMergeEligible } from "./auto-merge";
import { listChangedFiles, enableAutoMerge, approvePullRequest, type GithubClient } from "@/lib/github-client";
import { mintInstallationToken } from "@/lib/github-app";
import { fetchFilesContent } from "./ci-failure-detail";
import { filesToDiff } from "./file-changes";
import { reviewDiff } from "./detect";
import { decideCodeGate } from "./gate";
import { touchesSecuritySurface } from "./security-surface";
import { isTestPath } from "./reuse-enforcement";

/** A change larger than this is never auto-merged - a big diff is not the low-risk
 *  tail, a human authorizes it. Also bounds the content fetch for the gate read. */
export const MAX_AUTO_MERGE_FILES = 10;

export interface MaybeAutoMergeResult {
  attempted: boolean;
  enabled: boolean;
  reason: string;
  /** Present when the eligible tail also received a policy approving review. */
  approval?: { approved: boolean; reason: string };
}

/**
 * Submit the required approving review for an eligible PR, as an identity that
 * is NOT the PR author (GitHub forbids self-approval). The two automatable
 * identities are the agentgate-ai[bot] App installation token (minted per
 * workspace) and the shared PAT; we try each and take the first that is not the
 * author (the author's token 422s and is skipped). If neither is a distinct
 * identity - the common case until the App is installed on the repo - we skip
 * and a human approves, exactly as before. Fail-open.
 */
async function submitPolicyApproval(args: {
  repo: string;
  prNumber: number;
  drivingToken: string;
  workspaceId?: string;
}): Promise<{ approved: boolean; reason: string }> {
  const appToken = args.workspaceId
    ? await mintInstallationToken(args.workspaceId).catch(() => null)
    : null;
  const pat = process.env.GITHUB_TOKEN_WOLFPACK_AGENCY ?? "";
  // Distinct credentials only; the bot token is preferred (it is the purpose-
  // built reviewer identity and is almost never the author of a factory PR).
  const tokens = [...new Set([appToken, pat].filter(Boolean))] as string[];
  if (tokens.length === 0) {
    return { approved: false, reason: "no identity available to approve" };
  }
  let lastReason = "no distinct approver identity (self-approval blocked); human review required";
  for (const token of tokens) {
    const r = await approvePullRequest({ token, fetch: globalThis.fetch }, args.repo, args.prNumber);
    if (r.approved) return r;
    lastReason = r.reason;
  }
  return { approved: false, reason: lastReason };
}

export async function maybeAutoMerge(args: {
  client: GithubClient;
  repo: string;
  base: string;
  branch: string;
  prNumber?: number;
  workspaceId?: string;
  env?: Record<string, string | undefined>;
}): Promise<MaybeAutoMergeResult> {
  if (!autoMergeEnabled(args.env)) return { attempted: false, enabled: false, reason: "auto-merge flag off" };
  if (!args.prNumber || !args.client.token) return { attempted: false, enabled: false, reason: "no PR number or github token" };
  try {
    const files = await listChangedFiles(args.client, args.repo, args.base || "main", args.branch);
    if (files.length === 0) return { attempted: false, enabled: false, reason: "no changed files" };
    if (files.length > MAX_AUTO_MERGE_FILES) {
      return { attempted: false, enabled: false, reason: `change spans ${files.length} files (> ${MAX_AUTO_MERGE_FILES}); a human authorizes a large diff` };
    }
    const contents = await fetchFilesContent(args.client, args.repo, files, args.branch, {
      maxFiles: MAX_AUTO_MERGE_FILES,
      maxCharsPerFile: 20_000,
    });
    const verdict = decideCodeGate(reviewDiff(filesToDiff(contents)));
    const decision = autoMergeEligible({
      ciGreen: true, // only called at merge_ready = every required check is green
      gateOutcome: verdict.outcome,
      touchesSensitiveSurface: touchesSecuritySurface(files).length > 0,
      hasTests: files.some((f) => isTestPath(f)),
    });
    if (!decision.eligible) return { attempted: false, enabled: false, reason: decision.reason };
    const r = await enableAutoMerge(args.client, args.repo, args.prNumber);
    // Satisfy the required approving review with a distinct (non-author)
    // identity so the eligible tail merges with no human in the path. If no
    // distinct identity exists, auto-merge is still armed and waits for a human.
    const approval = await submitPolicyApproval({
      repo: args.repo,
      prNumber: args.prNumber,
      drivingToken: args.client.token,
      workspaceId: args.workspaceId,
    });
    return { attempted: true, enabled: r.enabled, reason: r.reason, approval };
  } catch (e) {
    return { attempted: false, enabled: false, reason: (e as Error).message.slice(0, 160) };
  }
}
