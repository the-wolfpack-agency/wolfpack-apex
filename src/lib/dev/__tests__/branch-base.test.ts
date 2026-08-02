/**
 * Every branch shape this check exists to catch. Two of them are real incidents
 * from this repo, and both are the reason a written-down rule was not enough:
 * the state is invisible in `git status` and `git log` reads perfectly normal.
 */
import { absorbedPrefix, classifyBranch, formatVerdict, type BranchFacts } from "../branch-base";

const commit = (sha: string, subject = "work") => ({ sha, subject });

const facts = (over: Partial<BranchFacts> = {}): BranchFacts => ({
  branch: "feat/thing",
  baseBranch: "origin/main",
  ahead: [],
  behind: 0,
  absorbedShas: [],
  openPr: null,
  ...over,
});

const byId = (v: ReturnType<typeof classifyBranch>) => Object.fromEntries(v.findings.map((f) => [f.id, f]));

describe("classifyBranch", () => {
  it("is quiet on a branch with nothing of its own and nothing behind", () => {
    const v = classifyBranch(facts());
    expect(v.needsAction).toBe(false);
    expect(byId(v).clean.detail).toMatch(/up to date/);
  });

  it("is quiet on ordinary unmerged work", () => {
    const v = classifyBranch(facts({ ahead: [commit("aaaaaaaa1"), commit("bbbbbbbb2")] }));
    expect(v.needsAction).toBe(false);
    expect(byId(v).clean).toBeDefined();
  });

  it("calls for action when the branch is entirely a squash-merged copy", () => {
    // PR #201's branch after it merged: every commit's content is in main under
    // a new sha, and every future push from here conflicts.
    const v = classifyBranch(facts({ ahead: [commit("aaaaaaaa1"), commit("bbbbbbbb2")], absorbedShas: ["aaaaaaaa1", "bbbbbbbb2"] }));
    expect(v.needsAction).toBe(true);
    expect(byId(v)["fully-absorbed"].commands).toEqual(["git reset --hard origin/main"]);
  });

  it("separates already-merged commits from genuinely new ones, and says drop rather than rebase", () => {
    // The exact state that produced the conflicted PR: two commits squashed into
    // main, one real follow-up on top.
    const v = classifyBranch(
      facts({
        ahead: [commit("aaaaaaaa1", "spec-diff"), commit("bbbbbbbb2", "spec-diff fixup"), commit("cccccccc3", "acceptance layer")],
        absorbedShas: ["aaaaaaaa1", "bbbbbbbb2"],
        behind: 2,
      }),
    );
    const f = byId(v)["squash-remnants"];
    expect(v.needsAction).toBe(true);
    expect(f.detail).toMatch(/2 commit\(s\).*already in origin\/main/);
    expect(f.because).toMatch(/conflict with their own squashed copy/);
    expect(f.commands[0]).toBe("git reset --hard origin/main");
    expect(f.commands[1]).toMatch(/^git cherry-pick cccccccc\b/);
    // Only the new work is cherry-picked; replaying the merged commits is the trap.
    expect(f.commands).toHaveLength(2);
  });

  it("does not tell you to rebase when the branch holds its own squashed copies", () => {
    // Rebase is the first thing anyone reaches for, and here it is wrong: it
    // replays the merged commits straight into a conflict.
    const v = classifyBranch(
      facts({ ahead: [commit("aaaaaaaa1"), commit("cccccccc3")], absorbedShas: ["aaaaaaaa1"], behind: 5 }),
    );
    expect(byId(v)["behind-base"]).toBeUndefined();
    expect(byId(v)["squash-remnants"]).toBeDefined();
  });

  it("warns when a follow-up is stacked on a branch that already has an open PR", () => {
    const v = classifyBranch(
      facts({
        ahead: [commit("aaaaaaaa1", "the reviewed work"), commit("dddddddd4", "the follow-up")],
        openPr: { number: 202, url: "https://github.com/x/y/pull/202" },
      }),
    );
    const f = byId(v)["stacked-on-open-pr"];
    expect(f.level).toBe("warn");
    expect(f.because).toMatch(/orphaned/);
    expect(f.commands[0]).toMatch(/git switch -c <new-branch> origin\/main/);
    expect(f.commands[1]).toMatch(/^git cherry-pick dddddddd\b/);
  });

  it("does not warn about a single-commit branch with an open PR", () => {
    // One commit IS the PR. There is nothing stacked and nothing to orphan.
    const v = classifyBranch(
      facts({ ahead: [commit("aaaaaaaa1")], openPr: { number: 202, url: "https://example.test/202" } }),
    );
    expect(byId(v)["stacked-on-open-pr"]).toBeUndefined();
    expect(v.needsAction).toBe(false);
  });

  it("suggests a plain rebase when the base simply moved on", () => {
    const v = classifyBranch(facts({ ahead: [commit("aaaaaaaa1")], behind: 3 }));
    expect(byId(v)["behind-base"].commands).toEqual(["git rebase origin/main"]);
    expect(v.needsAction).toBe(false);
  });
});

describe("absorbedPrefix", () => {
  const ahead = [commit("aaaaaaaa1"), commit("bbbbbbbb2"), commit("cccccccc3")];

  it("returns the longest prefix the base already contains", () => {
    // The base holds the branch as it stood at commit 2 (index 1).
    expect(absorbedPrefix(ahead, (i) => i === 1)).toEqual(["aaaaaaaa1", "bbbbbbbb2"]);
  });

  it("returns nothing when the base contains none of it", () => {
    expect(absorbedPrefix(ahead, () => false)).toEqual([]);
  });

  it("returns every commit when the whole branch is already upstream", () => {
    expect(absorbedPrefix(ahead, (i) => i === 2)).toHaveLength(3);
  });

  it("takes the FARTHEST match, not the first one it finds", () => {
    // This is the bug that let the first version of this check report a clean
    // branch on the exact incident it was written for: an earlier prefix can
    // fail to match because a later commit edited a file it also touched, while
    // a longer prefix matches perfectly.
    expect(absorbedPrefix(ahead, (i) => i === 0 || i === 2)).toHaveLength(3);
  });

  it("probes from the far end, so the cheap answer is found first", () => {
    const seen: number[] = [];
    absorbedPrefix(ahead, (i) => {
      seen.push(i);
      return i === 2;
    });
    expect(seen).toEqual([2]);
  });
});

describe("parked stashes", () => {
  it("warns on a clean branch, which is exactly where someone reaches for stash pop", () => {
    const v = classifyBranch(facts({ stashCount: 1 }));
    const f = byId(v)["parked-stash"];
    expect(f.level).toBe("warn");
    expect(f.detail).toMatch(/1 stash/);
    // Not blocking: a stash is someone's work, and refusing to proceed over it
    // would be the tool deciding something that is not its call.
    expect(v.needsAction).toBe(false);
  });

  it("warns on a branch with commits too, and offers preserve-then-clear", () => {
    const v = classifyBranch(facts({ ahead: [commit("aaaaaaaa1")], stashCount: 2 }));
    const f = byId(v)["parked-stash"];
    expect(f.commands.join(" ")).toMatch(/git tag -a archived-stash/);
    expect(f.commands.join(" ")).toMatch(/git stash drop/);
    // Preserve BEFORE clear: verifying a stash is redundant and being certain
    // of it are different things, and a tag costs nothing.
    expect(f.commands.findIndex((c) => c.includes("tag -a"))).toBeLessThan(
      f.commands.findIndex((c) => c.includes("stash drop")),
    );
  });

  it("says nothing when the stack is empty", () => {
    expect(byId(classifyBranch(facts({ stashCount: 0 })))["parked-stash"]).toBeUndefined();
    expect(byId(classifyBranch(facts()))["parked-stash"]).toBeUndefined();
  });

  it("explains the consequence, not just the count", () => {
    // "2 stashes held" is a fact nobody acts on. The reason is what makes it
    // a warning: a mismatched pop scatters conflict markers through unrelated
    // files, which is what happened on 2026-08-02.
    expect(byId(classifyBranch(facts({ stashCount: 1 })))["parked-stash"].because).toMatch(/including someone else's/);
  });
});

describe("formatVerdict", () => {
  it("prints the commands to run, and says plainly that pushing as-is conflicts", () => {
    const out = formatVerdict(
      classifyBranch(facts({ ahead: [commit("aaaaaaaa1"), commit("cccccccc3")], absorbedShas: ["aaaaaaaa1"] })),
    );
    expect(out).toMatch(/\[ACT \] squash-remnants/);
    expect(out).toMatch(/\$ git reset --hard origin\/main/);
    expect(out).toMatch(/produces a conflicted PR/);
  });

  it("says nothing is blocking on a clean branch", () => {
    expect(formatVerdict(classifyBranch(facts()))).toMatch(/Nothing blocking/);
  });
});
