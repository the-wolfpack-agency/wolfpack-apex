/**
 * npm run check:commit-hygiene [-- --strict]
 *
 * Applies the decidable commit-hygiene rules (src/lib/dev/commit-hygiene.ts) to
 * the commits this branch adds over origin/main: the GitHub noreply author, no
 * Co-Authored-By trailer, no private email. The rules are unit tested without a
 * repository; this file is only the git plumbing.
 *
 * Advisory by default (exits 0 so a local run never blocks). --strict exits 1 on
 * any violation - that is how CI (verify.sh) gates it. On main, or when
 * origin/main is not available, there are no branch commits to judge and it
 * passes cleanly.
 */
import { execFileSync } from "node:child_process";
import { checkCommits, DEFAULT_HYGIENE, type CommitRecord } from "../src/lib/dev/commit-hygiene";

const STRICT = process.argv.includes("--strict");
const BASE = process.env.BRANCH_BASE || "origin/main";
const US = "\x1f"; // unit separator, between author-email and message
const RS = "\x1e"; // record separator, between commits

function readCommits(): CommitRecord[] | null {
  try {
    const out = execFileSync("git", ["log", `${BASE}..HEAD`, `--format=%h%x1f%ae%x1f%B%x1e`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out
      .split(RS)
      .map((r) => r.trim())
      .filter(Boolean)
      .map((rec) => {
        const [sha, authorEmail, ...rest] = rec.split(US);
        return { sha, authorEmail: (authorEmail ?? "").trim(), message: rest.join(US) };
      });
  } catch {
    // No upstream / detached HEAD / not a repo: nothing to judge, don't break.
    return null;
  }
}

function main(): void {
  const commits = readCommits();
  if (commits === null) {
    console.log("commit-hygiene: no base to compare against; skipping.");
    return;
  }
  if (commits.length === 0) {
    console.log("commit-hygiene: no new commits over the base; clean.");
    return;
  }

  const violations = checkCommits(commits, DEFAULT_HYGIENE);
  if (violations.length === 0) {
    console.log(`commit-hygiene: ${commits.length} commit(s) checked, all clean.`);
    return;
  }

  console.log(`commit-hygiene: ${violations.length} violation(s) across ${commits.length} commit(s):`);
  for (const v of violations) {
    console.log(`  [${v.rule}] ${v.sha ?? "?"}: ${v.detail}`);
  }
  if (STRICT) process.exit(1);
}

main();
