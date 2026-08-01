/**
 * npm run branch:check — is this branch in a state that will produce a
 * conflicted or a silently-orphaned PR?
 *
 *   npx tsx scripts/check-branch-base.ts            # advisory, always exits 0
 *   npx tsx scripts/check-branch-base.ts --strict   # exits 1 when action needed
 *
 * The classification lives in src/lib/dev/branch-base.ts and is unit tested
 * without a repository. This file is only the gathering: git plumbing, plus an
 * optional `gh` lookup for an open PR that is skipped silently when the CLI is
 * absent or unauthenticated.
 *
 * THE DETECTION THAT MATTERS
 *
 * A squash-merge lands your work in main as a NEW commit with no ancestry link
 * to the originals, so `git cherry` and `git branch --merged` both report the
 * originals as unmerged. They are not: their CONTENT is upstream. We test for
 * that directly, and as a PREFIX question, because a squash collapses
 * everything that was reviewed at the time: at commit i, do the files commits
 * 0..i touched already read identically in the base?
 *
 * Asking it per commit instead is what this check got wrong on its first run
 * against the very incident it was written for. Commit 1 and commit 3 both
 * touched a generated baseline file, so commit 1's paths differed from the base
 * for a reason that had nothing to do with whether commit 1 had merged, and the
 * detector reported a clean branch. The prefix form has no such hole.
 *
 * One blind spot remains, stated rather than hidden: if someone else's edits to
 * exactly those paths happened to converge byte-for-byte with this branch, it
 * would read as absorbed. The check is advisory, so the cost of that is one
 * command not run.
 */
import { execFileSync } from "node:child_process";
import { absorbedPrefix, classifyBranch, formatVerdict, type BranchCommit } from "../src/lib/dev/branch-base";

const STRICT = process.argv.includes("--strict");
const BASE = process.env.BRANCH_BASE || "origin/main";

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Returns null when the command fails for an expected reason (no upstream, no
 *  gh, detached HEAD). A tooling check must never break someone's push. */
function tryGit(args: string[]): string | null {
  try {
    return git(args);
  } catch {
    return null;
  }
}

function openPrForBranch(branch: string): { number: number; url: string } | null {
  try {
    const out = execFileSync("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "number,url"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const rows = JSON.parse(out) as { number: number; url: string }[];
    return rows[0] ?? null;
  } catch {
    // gh missing, unauthenticated, or offline. The other findings still stand.
    return null;
  }
}

function main(): number {
  const branch = tryGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD") {
    console.log("branch-base check: detached HEAD or not a git repo, skipping.");
    return 0;
  }
  if (tryGit(["rev-parse", "--verify", BASE]) == null) {
    console.log(`branch-base check: ${BASE} not found locally (run git fetch), skipping.`);
    return 0;
  }
  // Comparing against a stale remote ref reports a branch as up to date when it
  // is not, which is the failure this check exists to prevent.
  tryGit(["fetch", "--quiet", "origin"]);

  const aheadRaw = tryGit(["log", "--reverse", "--format=%H%x1f%s", `${BASE}..HEAD`]) ?? "";
  const ahead: BranchCommit[] = aheadRaw
    ? aheadRaw.split("\n").map((line) => {
        const [sha, subject] = line.split("\x1f");
        return { sha, subject: subject ?? "" };
      })
    : [];
  const behind = Number(tryGit(["rev-list", "--count", `HEAD..${BASE}`]) ?? "0") || 0;

  // The squash-merge fingerprint, asked as a prefix question (see absorbedPrefix):
  // at commit i, do the files commits 0..i touched already read identically in
  // the base? Comparing the commit itself against the base — not HEAD against
  // the base — is what keeps a later edit to a shared file from hiding the
  // answer.
  const pathsAt = ahead.map((c) => (tryGit(["show", "--name-only", "--format=", c.sha]) ?? "").split("\n").filter(Boolean));
  const absorbedShas = absorbedPrefix(ahead, (i) => {
    // Recomputed per call rather than accumulated: absorbedPrefix probes from
    // the far end backwards, so a running union would carry later commits'
    // paths into an earlier prefix and answer a different question.
    const union = [...new Set(pathsAt.slice(0, i + 1).flat())];
    if (union.length === 0) return false;
    return tryGit(["diff", "--name-only", ahead[i].sha, BASE, "--", ...union]) === "";
  });

  const verdict = classifyBranch({
    branch,
    baseBranch: BASE,
    ahead,
    behind,
    absorbedShas,
    openPr: openPrForBranch(branch),
  });

  console.log(formatVerdict(verdict));
  return verdict.needsAction && STRICT ? 1 : 0;
}

process.exit(main());
