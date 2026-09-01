/**
 * Find merged pull requests whose code never reached the default branch.
 *
 * Stacked PRs plus squash-merge silently drop work: B is merged into A's
 * branch, A is squash-merged into main taking only A's diff, and B's code is
 * nowhere while GitHub shows both as merged. It has happened at least three
 * times in this repository. The judgment lives in src/lib/ci/merge-orphans.ts
 * and is tested there; this only fetches and prints.
 *
 *   npm run check:merge-orphans
 *   npm run check:merge-orphans -- --limit 60
 *
 * Needs the gh CLI, authenticated. Exits 1 when something is orphaned, so it
 * can gate a job rather than only inform a person.
 */
import { execFileSync } from "node:child_process";
import {
  classifyMerges,
  orphansOf,
  describe,
  classifyBranchTips,
  strandedOf,
  describeTips,
  type MergedPr,
  type BranchTip,
} from "@/lib/ci/merge-orphans";

const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) || 40 : 40;

const sh = (cmd: string, args: string[]): string =>
  execFileSync(cmd, args, { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 }).trim();

/**
 * Same, with stderr discarded.
 *
 * For a probe whose whole answer is its exit code. `git cat-file -e` on a
 * missing path writes "fatal: path does not exist", which is the expected
 * answer here, and letting it through buries the actual report under one
 * alarming-looking line per file checked.
 */
const probe = (cmd: string, args: string[]): boolean => {
  try {
    execFileSync(cmd, args, { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
};

function defaultBranch(): string {
  try {
    return JSON.parse(sh("gh", ["repo", "view", "--json", "defaultBranchRef"])).defaultBranchRef
      .name as string;
  } catch {
    return "main";
  }
}

/**
 * Files a PR added, as opposed to changed.
 *
 * gh reports additions and deletions per file but not the status, so a file
 * with zero deletions is treated as added. Wrong only for a file that was
 * rewritten with no lines removed, which lands in the unverifiable bucket
 * rather than the orphaned one.
 */
function addedFiles(number: number): string[] {
  try {
    const data = JSON.parse(sh("gh", ["pr", "view", String(number), "--json", "files"])) as {
      files: { path: string; deletions: number }[];
    };
    return data.files.filter((f) => f.deletions === 0).map((f) => f.path);
  } catch {
    return [];
  }
}

function main() {
  const branch = defaultBranch();
  /* Fetched first, so a stale local ref cannot report a present file as
     missing and send somebody cherry-picking work that is already there. */
  try {
    sh("git", ["fetch", "--quiet", "origin", branch]);
  } catch {
    console.log(`Could not fetch origin/${branch}; comparing against the local ref.`);
  }

  const ref = probe("git", ["rev-parse", "--verify", `origin/${branch}`])
    ? `origin/${branch}`
    : branch;

  const merged = JSON.parse(
    sh("gh", [
      "pr", "list", "--state", "merged", "--limit", String(LIMIT),
      "--json", "number,title,baseRefName",
    ]),
  ) as { number: number; title: string; baseRefName: string }[];

  /* Only stacked PRs are fetched in detail: asking gh for the file list of
     every merged PR is dozens of round trips to answer a question that base
     branch alone already settles. */
  const stacked = merged.filter((p) => p.baseRefName !== branch);
  console.log(
    `${merged.length} merged PRs checked, ${stacked.length} of them stacked on another branch.\n`,
  );

  const prs: MergedPr[] = stacked.map((p) => ({ ...p, addedFiles: addedFiles(p.number) }));

  const inRef = (path: string): boolean => probe("git", ["cat-file", "-e", `${ref}:${path}`]);

  const verdicts = classifyMerges(prs, branch, inRef);
  console.log(describe(verdicts, branch));

  /* THE SECOND SHAPE. A commit pushed to a branch after its own pull request
     merged: GitHub shows the pull request merged, the branch carries a commit
     nobody will ever merge, and the default branch never gets it. This check
     reported clean through exactly that on 2026-08-30. */
  console.log("");
  console.log(describeTips(classifyBranchTips(branchTips(merged, ref)), branch));

  const lost = orphansOf(verdicts).length + strandedOf(classifyBranchTips(branchTips(merged, ref))).length;
  process.exit(lost > 0 ? 1 : 0);
}

/**
 * Are the lines this commit ADDED present in the default branch?
 *
 * "Does the file differ" is the wrong question and the first version asked it,
 * then reported a branch whose work had already been re-landed: main had
 * simply moved past it, which is true of every branch ever merged. A check
 * that fires on all of them protects nothing.
 *
 * Nor can this be asked with SHAs or patch-ids. A squash merge rewrites
 * history, and work re-landed inside a LARGER commit has no matching patch-id
 * either, so `git cherry` reports the same false positive.
 *
 * What survives all of that is the text. If the substantive lines a commit
 * added are findable in the default branch, the work arrived, however it got
 * there. Sampled and thresholded rather than requiring every line, because a
 * re-land is usually a rebase with small adjustments, and demanding an exact
 * match would put us back to crying wolf.
 */
const SAMPLE_LINES = 20;
const PRESENT_ENOUGH = 0.6;

function contentIsInDefault(commits: string[], file: string, ref: string): boolean {
  const added: string[] = [];
  for (const sha of commits) {
    const patch = sh("git", ["show", sha, "--format=", "--unified=0", "--", file]);
    for (const line of patch.split("\n")) {
      if (!line.startsWith("+") || line.startsWith("+++")) continue;
      const text = line.slice(1).trim();
      /* Long enough to be a fingerprint. A closing brace is in every file. */
      if (text.length >= 24) added.push(text);
    }
  }
  /* Nothing substantive was added, so there is nothing to stand. */
  if (added.length === 0) return true;

  const sample = added.slice(0, SAMPLE_LINES);
  const found = sample.filter((line) =>
    probe("git", ["grep", "--quiet", "--fixed-strings", line, ref]),
  ).length;
  return found / sample.length >= PRESENT_ENOUGH;
}

/**
 * Commits pushed to a merged branch after it merged, and whether they matter.
 *
 * SHAs cannot answer this. A squash merge rewrites history, so no commit on
 * the branch is ever reachable from the default branch and "is this commit in
 * main" answers no for every branch ever merged. The question is asked about
 * CONTENT instead: does the branch's version of a file differ from the default
 * branch's, narrowed to the files those late commits touched. Comparing whole
 * trees would flag every branch main has simply moved past, which is all of
 * them.
 */
function branchTips(
  merged: { number: number; title: string; baseRefName: string }[],
  ref: string,
): BranchTip[] {
  const withBranch = JSON.parse(
    sh("gh", [
      "pr", "list", "--state", "merged", "--limit", String(LIMIT),
      "--json", "number,title,headRefName,mergedAt",
    ]),
  ) as { number: number; title: string; headRefName: string; mergedAt: string }[];

  const tips: BranchTip[] = [];
  for (const pr of withBranch) {
    const remote = `origin/${pr.headRefName}`;
    /* A deleted branch cannot strand anything, which is an argument for
       deleting them on merge. */
    if (!probe("git", ["rev-parse", "--verify", remote])) continue;

    const lateCommits = sh("git", [
      "log", remote, `--since=${pr.mergedAt}`, "--format=%H", "--no-merges",
    ])
      .split("\n")
      .filter(Boolean);
    if (lateCommits.length === 0) continue;

    const oldest = lateCommits[lateCommits.length - 1];
    const touched = sh("git", ["diff", "--name-only", `${oldest}^`, remote])
      .split("\n")
      .filter(Boolean);

    const filesDifferingFromDefault = touched.filter((f) => !contentIsInDefault(lateCommits, f, ref));

    tips.push({
      pr: pr.number,
      title: pr.title,
      branch: pr.headRefName,
      lateCommits,
      filesDifferingFromDefault,
    });
  }
  return tips;
}

main();
