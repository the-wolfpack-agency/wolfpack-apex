/**
 * Merged, and not in main. The failure that keeps costing a session an hour.
 *
 * WHAT HAPPENS. Work is stacked: PR B is opened with PR A's branch as its
 * base, because B genuinely depends on A. B gets merged into A's branch. Then
 * A is SQUASH-merged into main, and a squash takes A's diff as it stood when
 * the merge started. B's commits are not in that diff. GitHub reports both as
 * merged, both show a green merged badge, and B's code is nowhere in main.
 *
 * Nothing catches it. Not CI, which only ever saw the branch. Not the PR list,
 * where both are merged. Not the person who merged them, who did nothing
 * wrong. It surfaces days later when somebody notices a file missing, and by
 * then the branch may be deleted.
 *
 * This has now happened at least three times in this repository, and each time
 * the response was to remember harder. This is the deterministic version of
 * remembering.
 *
 * HOW IT DECIDES. A merged PR that added files, whose base was not the default
 * branch, and NONE of whose added files exist in the default branch, is
 * orphaned. All three conditions matter:
 *
 *   - Added files only. A PR that edits existing files cannot be checked this
 *     way, because the file exists in main either way. Those are reported as
 *     unverifiable rather than passed, because silently passing them would
 *     make this check look more complete than it is.
 *   - Base not the default branch. A PR merged straight to main is in main.
 *   - NONE rather than SOME. A partially-present PR is a different situation
 *     (a later PR moved a file, a rename) and calling it orphaned would train
 *     everybody to ignore the check.
 */

export interface MergedPr {
  number: number;
  title: string;
  baseRefName: string;
  /** Paths the PR ADDED. Modified paths cannot be checked this way. */
  addedFiles: string[];
}

export type Verdict =
  | { pr: MergedPr; state: "in-main" }
  | { pr: MergedPr; state: "orphaned"; missing: string[] }
  /** Merged into the default branch directly, so there is nothing to check. */
  | { pr: MergedPr; state: "direct" }
  /** Added no files, so presence in main cannot be decided from paths alone. */
  | { pr: MergedPr; state: "unverifiable"; because: string };

/**
 * Classify merged PRs against what is actually in the default branch.
 *
 * existsInDefault is injected rather than shelling out here, so the whole
 * judgment is testable without a repository and the CLI stays a thin wrapper.
 */
export function classifyMerges(
  prs: MergedPr[],
  defaultBranch: string,
  existsInDefault: (path: string) => boolean,
): Verdict[] {
  return prs.map((pr): Verdict => {
    if (pr.baseRefName === defaultBranch) return { pr, state: "direct" };

    if (pr.addedFiles.length === 0) {
      /* REPORTED, NOT PASSED. A stacked PR that only edited existing files can
         be just as orphaned and this method cannot see it. Saying so is the
         difference between a check and a false reassurance. */
      return {
        pr,
        state: "unverifiable",
        because: "added no new files, so presence cannot be decided from paths",
      };
    }

    const missing = pr.addedFiles.filter((f) => !existsInDefault(f));
    /* NONE present, not SOME. A partially-present PR is a rename or a later
       move, and flagging those would train everybody to ignore this. */
    if (missing.length === pr.addedFiles.length) return { pr, state: "orphaned", missing };
    return { pr, state: "in-main" };
  });
}

export function orphansOf(verdicts: Verdict[]): Extract<Verdict, { state: "orphaned" }>[] {
  return verdicts.filter((v): v is Extract<Verdict, { state: "orphaned" }> => v.state === "orphaned");
}

/**
 * What to tell somebody, including how to fix it.
 *
 * A check that reports a problem without the recovery is a check people learn
 * to scroll past. The recovery is a cherry-pick, and it is short.
 */
export function describe(verdicts: Verdict[], defaultBranch: string): string {
  const orphans = orphansOf(verdicts);
  const unverifiable = verdicts.filter((v) => v.state === "unverifiable");
  const lines: string[] = [];

  if (orphans.length === 0) {
    lines.push(`No orphaned merges: every stacked PR checked is present in ${defaultBranch}.`);
  } else {
    lines.push(
      `${orphans.length} merged PR(s) are NOT in ${defaultBranch}.`,
      `A squash of the parent branch took its diff as it stood, leaving these behind.`,
      ``,
    );
    for (const o of orphans) {
      lines.push(
        `  #${o.pr.number} ${o.pr.title.slice(0, 66)}`,
        `     merged into ${o.pr.baseRefName}, ${o.missing.length} file(s) missing from ${defaultBranch}`,
        `     e.g. ${o.missing.slice(0, 3).join(", ")}`,
        `     recover: git cherry-pick <the PR's commit>  (the branch may need restoring first)`,
        ``,
      );
    }
  }

  /* Said out loud every run, not only when something is wrong. A reader
     needs to know how much of the list this actually looked at. */
  if (unverifiable.length > 0) {
    lines.push(
      `${unverifiable.length} stacked PR(s) could not be checked this way (they added no new files).`,
    );
  }
  return lines.join("\n");
}

/**
 * The second shape of the same failure, found the hard way.
 *
 * classifyMerges above catches a STACKED pull request whose parent was
 * squashed. It reported clean on 2026-08-30 while work was missing from main,
 * because the loss had a different shape: a commit pushed to a branch seconds
 * after that branch's own pull request merged. GitHub shows the pull request
 * merged, the branch carries a commit nobody will ever merge, and main never
 * gets it.
 *
 * Same family, and worth stating plainly: work that exists on a remote branch
 * and not in main. The first check knew one way of getting there.
 *
 * WHY SHAs CANNOT ANSWER THIS. A squash merge rewrites history, so no commit
 * on the branch is ever reachable from main and "is this commit in main" says
 * "no" for every branch ever merged. The question has to be asked about
 * CONTENT: does the branch's version of a file differ from main's.
 *
 * NARROWED TO THE FILES THE LATE COMMITS TOUCHED. Comparing whole trees would
 * flag every branch that main has simply moved past, which is all of them, and
 * a check that fires on everything protects nothing.
 */

export interface BranchTip {
  pr: number;
  title: string;
  branch: string;
  /** Commits pushed to the branch after its pull request merged. */
  lateCommits: string[];
  /** Of the files those commits touched, the ones whose content differs from
   *  the default branch. Empty means the work is present, however it got there. */
  filesDifferingFromDefault: string[];
}

export type TipVerdict =
  | { tip: BranchTip; state: "landed" }
  | { tip: BranchTip; state: "stranded" };

/**
 * A branch carrying work that never reached the default branch.
 *
 * Requires BOTH a late commit and a real content difference. A late commit
 * whose content already matches main is somebody re-pushing the same change,
 * or a merge back from main, and reporting it would train everybody to ignore
 * this.
 */
export function classifyBranchTips(tips: BranchTip[]): TipVerdict[] {
  return tips.map((tip): TipVerdict =>
    tip.lateCommits.length > 0 && tip.filesDifferingFromDefault.length > 0
      ? { tip, state: "stranded" }
      : { tip, state: "landed" },
  );
}

export function strandedOf(verdicts: TipVerdict[]): Extract<TipVerdict, { state: "stranded" }>[] {
  return verdicts.filter(
    (v): v is Extract<TipVerdict, { state: "stranded" }> => v.state === "stranded",
  );
}

export function describeTips(verdicts: TipVerdict[], defaultBranch: string): string {
  const stranded = strandedOf(verdicts);
  if (stranded.length === 0) {
    return `No stranded branches: nothing was pushed to a merged branch and left behind.`;
  }
  const lines = [
    `${stranded.length} merged branch(es) carry work that is not in ${defaultBranch}.`,
    `Something was pushed after the pull request merged, so nothing will ever merge it.`,
    ``,
  ];
  for (const s of stranded) {
    lines.push(
      `  #${s.tip.pr} ${s.tip.title.slice(0, 62)}`,
      `     branch ${s.tip.branch}, ${s.tip.lateCommits.length} commit(s) after the merge`,
      `     differs from ${defaultBranch} in: ${s.tip.filesDifferingFromDefault.slice(0, 3).join(", ")}`,
      `     recover: git cherry-pick ${s.tip.lateCommits[0]?.slice(0, 12) ?? "<commit>"}`,
      ``,
    );
  }
  return lines.join("\n");
}
