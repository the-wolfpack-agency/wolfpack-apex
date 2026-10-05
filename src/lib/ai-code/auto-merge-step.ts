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
import { listChangedFiles, enableAutoMerge, type GithubClient } from "@/lib/github-client";
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
}

export async function maybeAutoMerge(args: {
  client: GithubClient;
  repo: string;
  base: string;
  branch: string;
  prNumber?: number;
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
    return { attempted: true, enabled: r.enabled, reason: r.reason };
  } catch (e) {
    return { attempted: false, enabled: false, reason: (e as Error).message.slice(0, 160) };
  }
}
