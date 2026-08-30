/**
 * Find merged pull requests whose code never reached the default branch.
 *
 * Stacked PRs plus squash-merge silently drop work: B is merged into A's
 * branch, A is squash-merged into main taking only A's diff, and B's code is
 * nowhere while GitHub shows both as merged. It has happened at least three
 * times in this repository. The judgement lives in src/lib/ci/merge-orphans.ts
 * and is tested there; this only fetches and prints.
 *
 *   npm run check:merge-orphans
 *   npm run check:merge-orphans -- --limit 60
 *
 * Needs the gh CLI, authenticated. Exits 1 when something is orphaned, so it
 * can gate a job rather than only inform a person.
 */
import { execFileSync } from "node:child_process";
import { classifyMerges, orphansOf, describe, type MergedPr } from "@/lib/ci/merge-orphans";

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
  process.exit(orphansOf(verdicts).length > 0 ? 1 : 0);
}

main();
