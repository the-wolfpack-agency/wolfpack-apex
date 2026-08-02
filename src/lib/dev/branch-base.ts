/**
 * Branch-base hygiene: catch the states that turn a clean branch into a merge
 * conflict, before the push rather than after the review.
 *
 * WHY THIS EXISTS
 *
 * This repo squash-merges. A squash replaces N commits with ONE new commit that
 * has no ancestry link to the originals, and two things follow that have each
 * cost a session:
 *
 *   1. Work pushed onto a branch whose PR then squash-merges is ORPHANED. The
 *      merge captures the state at review time; the follow-up commit stays on a
 *      branch that is then deleted, and the change silently never reaches
 *      production.
 *   2. A branch that keeps its originals after its own PR squash-merged now
 *      contains commits whose content is ALREADY in main under a different sha.
 *      Rebasing replays them, they conflict with their own squashed copy, and
 *      the PR shows conflicts on code nobody touched twice.
 *
 * Both were written down as a rule to remember, and both happened again anyway,
 * because a rule that lives in someone's head is not a control. This module is
 * the control: the same conditions, detected from git facts, with the exact
 * commands to get out.
 *
 * Pure. It takes gathered facts and returns findings, so every branch shape
 * below is unit tested without a repository, and the CLI wrapper
 * (scripts/check-branch-base.ts) is the only part that shells out to git.
 */

export interface BranchCommit {
  sha: string;
  subject: string;
}

export interface BranchFacts {
  /**
   * Entries on the stash stack.
   *
   * A parked stash is a landmine, not a note-to-self. `git stash pop` in any
   * later session takes whatever is on top — including someone else's — and a
   * mismatched pop leaves conflict markers strewn across files nobody in that
   * session touched. That happened on 2026-08-02: a stash named
   * "polluted-origin-main-content-from-botched-checkout" collided with an
   * unrelated pop and left markers in package-lock.json, executor.ts,
   * template.ts and constitution/generated.ts.
   */
  stashCount?: number;
  /** The branch being checked, e.g. "feat/thing". */
  branch: string;
  /** What it will merge into, e.g. "origin/main". */
  baseBranch: string;
  /** Commits on the branch but not in the base, OLDEST FIRST. */
  ahead: BranchCommit[];
  /** Commits in the base but not on the branch. */
  behind: number;
  /**
   * Shas from `ahead` whose content is already fully present in the base: every
   * path they touched now reads identically on both sides. That is the
   * fingerprint of a squash-merge, which patch-equality (`git cherry`) cannot
   * see because the squash is a different patch.
   */
  absorbedShas: string[];
  /** An open PR for this branch, when one could be resolved. */
  openPr?: { number: number; url: string } | null;
}

export type FindingLevel = "ok" | "warn" | "act";

export interface Finding {
  id: "fully-absorbed" | "squash-remnants" | "stacked-on-open-pr" | "behind-base" | "parked-stash" | "clean";
  level: FindingLevel;
  /** What is true, in one line. */
  detail: string;
  /** Why it matters, when the consequence is not obvious from the detail. */
  because?: string;
  /** Commands that fix it, in order. Empty when there is nothing to do. */
  commands: string[];
}

export interface BranchVerdict {
  findings: Finding[];
  /** True when at least one finding needs an action before pushing. */
  needsAction: boolean;
}

const shortSha = (sha: string) => sha.slice(0, 8);

/**
 * Which commits a squash-merge already put in the base.
 *
 * A squash collapses a PREFIX of the branch (everything reviewed at the time)
 * into one upstream commit, so the question is not "is this individual commit
 * upstream" but "how far along this branch does the base already contain".
 * `matchesBase(i)` answers that for the branch state AT commit i, restricted to
 * the files commits 0..i touched: true means the base already holds everything
 * the branch had produced by then.
 *
 * Taking the LONGEST such prefix matters. Asking per commit gives the wrong
 * answer whenever a later commit edits a file an earlier one also touched (a
 * generated baseline, a shared union type), because that file then differs from
 * the base for reasons that have nothing to do with whether the earlier work
 * merged. That false negative is precisely how this check failed the first time
 * it was pointed at the incident it was written for.
 */
export function absorbedPrefix(ahead: BranchCommit[], matchesBase: (index: number) => boolean): string[] {
  for (let i = ahead.length - 1; i >= 0; i--) {
    if (matchesBase(i)) return ahead.slice(0, i + 1).map((c) => c.sha);
  }
  return [];
}

/**
 * Classify a branch. Order matters: the remnant state is reported before the
 * plain behind-base one, because "rebase onto main" is the WRONG advice when
 * the branch contains its own squashed copies, and it is the advice a developer
 * reaches for first.
 */
export function classifyBranch(facts: BranchFacts): BranchVerdict {
  const findings: Finding[] = [];
  const { branch, baseBranch, ahead, behind, absorbedShas, openPr } = facts;

  const absorbed = ahead.filter((c) => absorbedShas.includes(c.sha));
  const fresh = ahead.filter((c) => !absorbedShas.includes(c.sha));

  if (ahead.length === 0) {
    findings.push({
      id: "clean",
      level: "ok",
      detail: behind > 0 ? `no commits of your own; ${behind} behind ${baseBranch}` : `up to date with ${baseBranch}`,
      commands: behind > 0 ? [`git reset --hard ${baseBranch}`] : [],
    });
    // A parked stash is dangerous on a clean branch too — arguably more so,
    // because a clean branch is where someone reaches for `git stash pop`.
    if ((facts.stashCount ?? 0) > 0) {
      findings.push({
        id: "parked-stash",
        level: "warn",
        detail: `${facts.stashCount} stash entr(ies) on the stack`,
        because: "a later `git stash pop` takes whatever is on top, including someone else's",
        commands: ["git stash list"],
      });
    }
    return { findings, needsAction: false };
  }

  if (absorbed.length > 0 && fresh.length === 0) {
    findings.push({
      id: "fully-absorbed",
      level: "act",
      detail: `all ${absorbed.length} commit(s) on ${branch} are already in ${baseBranch} under a different sha`,
      because: "this branch was squash-merged; keeping the originals only creates conflicts from here on",
      commands: [`git reset --hard ${baseBranch}`],
    });
    return { findings, needsAction: true };
  }

  if (absorbed.length > 0 && fresh.length > 0) {
    findings.push({
      id: "squash-remnants",
      level: "act",
      detail: `${absorbed.length} commit(s) on ${branch} are already in ${baseBranch} (${absorbed
        .map((c) => shortSha(c.sha))
        .join(", ")}), ${fresh.length} are genuinely new`,
      because:
        "a rebase replays the already-merged commits and they conflict with their own squashed copy; the fix is to drop them, not to resolve them",
      commands: [`git reset --hard ${baseBranch}`, ...fresh.map((c) => `git cherry-pick ${shortSha(c.sha)}  # ${c.subject}`)],
    });
  }

  if (openPr && fresh.length > 1) {
    findings.push({
      id: "stacked-on-open-pr",
      level: "warn",
      detail: `${branch} has ${fresh.length} commits and an open PR (#${openPr.number})`,
      because:
        "if that PR squash-merges while you add to it, only the reviewed state lands and the follow-up is orphaned on a deleted branch",
      commands: [
        `git switch -c <new-branch> ${baseBranch}`,
        `git cherry-pick ${shortSha(fresh[fresh.length - 1].sha)}  # the follow-up, onto its own PR`,
      ],
    });
  }

  if ((facts.stashCount ?? 0) > 0) {
    findings.push({
      id: "parked-stash",
      level: "warn",
      detail: `${facts.stashCount} stash entr(ies) on the stack`,
      because:
        "a later `git stash pop` takes whatever is on top, including someone else's, and a mismatched pop scatters conflict markers through files this session never touched",
      commands: [
        "git stash list",
        "git tag -a archived-stash/<what-it-is> stash@{0} -m 'why'  # preserve",
        "git stash drop stash@{0}                                    # then clear",
      ],
    });
  }

  if (behind > 0 && absorbed.length === 0) {
    findings.push({
      id: "behind-base",
      level: "warn",
      detail: `${baseBranch} has moved on ${behind} commit(s) since this branch diverged`,
      commands: [`git rebase ${baseBranch}`],
    });
  }

  if (findings.length === 0) {
    findings.push({
      id: "clean",
      level: "ok",
      detail: `${ahead.length} commit(s) ahead of ${baseBranch}, nothing already merged`,
      commands: [],
    });
  }

  return { findings, needsAction: findings.some((f) => f.level === "act") };
}

/** Console rendering. Kept here so the CLI and any future surface print the
 *  same thing, and so the formatting itself is testable. */
export function formatVerdict(verdict: BranchVerdict): string {
  const icon: Record<FindingLevel, string> = { ok: "[ ok ]", warn: "[warn]", act: "[ACT ]" };
  const lines: string[] = ["branch-base check", "=".repeat(64)];
  for (const f of verdict.findings) {
    lines.push(`${icon[f.level]} ${f.id.padEnd(20)} ${f.detail}`);
    if (f.because) lines.push(`         why: ${f.because}`);
    for (const cmd of f.commands) lines.push(`         $ ${cmd}`);
  }
  lines.push("=".repeat(64));
  lines.push(
    verdict.needsAction
      ? "Fix the [ACT] item(s) above before pushing; pushing as-is produces a conflicted PR."
      : "Nothing blocking.",
  );
  return lines.join("\n");
}
