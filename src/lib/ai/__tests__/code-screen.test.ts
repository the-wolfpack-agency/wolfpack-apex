/**
 * The screen has to survive the two ways it would lie to us.
 *
 * The first is arithmetic: a model that passes nothing has the lowest cost per
 * call on the board, and any leaderboard sorting on price would put it first.
 * The second is adversarial: "make the gate pass" is trivially solved by
 * deleting the failing test, which scores a perfect run while producing the
 * worst change in the set.
 *
 * Both are tested here, because a screen that gets either wrong is worse than
 * no screen: it produces a confident number pointing the wrong way.
 */
import {
  scoreScreen,
  detectOracleGaming,
  countTestCaseDelta,
  filesTouchedByPatch,
  type ScreenAttempt,
  type CodeTask,
} from "@/lib/ai/code-screen";

const TASK: CodeTask = {
  id: "t1",
  prompt: "Make the router downgrade to the most capable available model.",
  baseCommit: "aeeac55a",
  targetFile: "src/lib/ai/models/router.ts",
  gradedBy: ["src/lib/ai/models/__tests__/downgrade-steps-down.test.ts"],
};

function attempt(over: Partial<ScreenAttempt> & Pick<ScreenAttempt, "model">): ScreenAttempt {
  return { taskId: "t1", outcome: "passed", costUsd: 0.01, latencyMs: 1000, ...over };
}

describe("cost per passing task", () => {
  /* THE ARITHMETIC TRAP. Cheap-and-useless must never outrank dear-and-working,
     and the only way to guarantee that is to refuse the division rather than
     pick a number for it. */
  it("is null for a model that passed nothing, not zero and not infinity", () => {
    const r = scoreScreen([
      attempt({ model: "cheap", outcome: "failed", costUsd: 0.001 }),
      attempt({ model: "cheap", outcome: "failed", costUsd: 0.001 }),
    ]);
    expect(r.scores[0]!.costPerPassingTaskUsd).toBeNull();
    expect(r.winner).toBeNull();
  });

  it("keeps a model that passed nothing visible instead of dropping it", () => {
    const r = scoreScreen([
      attempt({ model: "cheap", outcome: "failed", costUsd: 0.001 }),
      attempt({ model: "dear", outcome: "passed", costUsd: 0.5 }),
    ]);
    expect(r.unranked.map((s) => s.model)).toEqual(["cheap"]);
    expect(r.ranked.map((s) => s.model)).toEqual(["dear"]);
    expect(r.winner).toBe("dear");
  });

  /* THE POINT OF THE WHOLE MODULE. Ten calls at a tenth the price that pass
     once cost MORE per shipped change than two calls at full price that pass
     twice. Per-call pricing says the opposite. */
  it("charges a model for its failures, so cheap-but-wrong loses", () => {
    const cheap: ScreenAttempt[] = Array.from({ length: 10 }, (_, i) =>
      attempt({
        model: "cheap",
        taskId: `t${i}`,
        outcome: i === 0 ? "passed" : "failed",
        costUsd: 0.01,
      }),
    );
    const dear: ScreenAttempt[] = Array.from({ length: 2 }, (_, i) =>
      attempt({ model: "dear", taskId: `t${i}`, outcome: "passed", costUsd: 0.1 }),
    );

    const r = scoreScreen([...cheap, ...dear]);
    const c = r.scores.find((s) => s.model === "cheap")!;
    const d = r.scores.find((s) => s.model === "dear")!;

    /* cheap: $0.10 spent, 1 pass  -> $0.100 per passing task
       dear:  $0.20 spent, 2 passes -> $0.100 ... make the gap explicit */
    expect(c.costPerPassingTaskUsd).toBeCloseTo(0.1, 6);
    expect(d.costPerPassingTaskUsd).toBeCloseTo(0.1, 6);
    /* Ten times cheaper per call, and exactly the same per shipped change. That
       is the finding a per-call dashboard can never show. */
    expect(c.totalCostUsd).toBeLessThan(d.totalCostUsd);
    expect(c.passRate).toBeCloseTo(0.1, 6);
    expect(d.passRate).toBe(1);
  });

  it("ranks cheapest per passing task first", () => {
    const r = scoreScreen([
      attempt({ model: "a", outcome: "passed", costUsd: 0.30 }),
      attempt({ model: "b", outcome: "passed", costUsd: 0.05 }),
      attempt({ model: "c", outcome: "passed", costUsd: 0.10 }),
    ]);
    expect(r.ranked.map((s) => s.model)).toEqual(["b", "c", "a"]);
    expect(r.winner).toBe("b");
    expect(r.savingPerTaskUsd).toBeCloseTo(0.25, 6);
  });

  /* A saving needs something to be cheaper THAN. Reporting one against a field
     of one is how a screen turns into marketing. */
  it("reports no saving when only one model passed anything", () => {
    const r = scoreScreen([
      attempt({ model: "only", outcome: "passed" }),
      attempt({ model: "other", outcome: "failed" }),
    ]);
    expect(r.winner).toBe("only");
    expect(r.savingPerTaskUsd).toBeNull();
  });

  it("counts every outcome and bills all of them", () => {
    const r = scoreScreen([
      attempt({ model: "m", outcome: "passed", costUsd: 0.01 }),
      attempt({ model: "m", outcome: "failed", costUsd: 0.02 }),
      attempt({ model: "m", outcome: "disqualified", costUsd: 0.03 }),
      attempt({ model: "m", outcome: "no_patch", costUsd: 0.04 }),
      attempt({ model: "m", outcome: "errored", costUsd: 0 }),
    ]);
    const s = r.scores[0]!;
    expect([s.passed, s.failed, s.disqualified, s.noPatch, s.errored]).toEqual([1, 1, 1, 1, 1]);
    /* A disqualified attempt was still billed. Not charging for it would make
       gaming the oracle free. */
    expect(s.totalCostUsd).toBeCloseTo(0.1, 6);
    expect(s.costPerPassingTaskUsd).toBeCloseTo(0.1, 6);
  });
});

describe("detecting a model that games the oracle", () => {
  const diff = (...files: string[]) =>
    files.map((f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-x\n+y`).join("\n");

  /* THE TRIVIAL SOLUTION. Delete the exam and you pass it. */
  it("rejects a patch that edits the test grading this task", () => {
    const v = detectOracleGaming(diff(TASK.gradedBy[0]!), TASK);
    expect(v.gamed).toBe(true);
    expect(v.reasons).toContain("edited_graded_test");
    expect(v.offendingFiles).toEqual([TASK.gradedBy[0]]);
  });

  it.each([
    "scripts/verify.sh",
    "jest.config.ts",
    ".github/workflows/ci.yml",
  ])("rejects a patch that changes the gate itself (%s)", (file) => {
    const v = detectOracleGaming(diff(file), TASK);
    expect(v.gamed).toBe(true);
    expect(v.reasons).toContain("weakened_the_gate");
  });

  it("rejects a patch that removes more test cases than it adds", () => {
    const patch = [
      "diff --git a/src/x.test.ts b/src/x.test.ts",
      "--- a/src/x.test.ts",
      "+++ b/src/x.test.ts",
      "@@ -1,3 +1,1 @@",
      '-  it("handles empty input", () => {});',
      '-  it("handles null input", () => {});',
      '+  it("handles input", () => {});',
    ].join("\n");
    const v = detectOracleGaming(patch, TASK);
    expect(v.gamed).toBe(true);
    expect(v.reasons).toContain("deleted_test_cases");
  });

  /* A rename moves the count on BOTH sides. Treating that as an attack would
     reject honest refactors, which is how a guardrail gets switched off. */
  it("allows a refactor that renames tests without removing any", () => {
    const patch = [
      "diff --git a/src/x.test.ts b/src/x.test.ts",
      "--- a/src/x.test.ts",
      "+++ b/src/x.test.ts",
      "@@ -1,2 +1,2 @@",
      '-  it("old name", () => {});',
      '+  it("clearer name", () => {});',
    ].join("\n");
    expect(detectOracleGaming(patch, TASK).gamed).toBe(false);
  });

  it("allows an ordinary source change that adds tests elsewhere", () => {
    const patch = [
      "diff --git a/src/lib/ai/models/router.ts b/src/lib/ai/models/router.ts",
      "--- a/src/lib/ai/models/router.ts",
      "+++ b/src/lib/ai/models/router.ts",
      "@@ -1 +1 @@",
      "-const x = cheapest(all);",
      "+const x = mostCapable(all);",
      "diff --git a/src/lib/ai/__tests__/new.test.ts b/src/lib/ai/__tests__/new.test.ts",
      "--- /dev/null",
      "+++ b/src/lib/ai/__tests__/new.test.ts",
      "@@ -0,0 +1 @@",
      '+  it("steps down one rung", () => {});',
    ].join("\n");
    const v = detectOracleGaming(patch, TASK);
    expect(v.gamed).toBe(false);
    expect(v.reasons).toEqual([]);
  });

  /* Disqualified must be distinguishable from failed. One model could not do
     the work; the other tried to change the rules. */
  it("reports every reason it fired, not just the first", () => {
    const v = detectOracleGaming(diff(TASK.gradedBy[0]!, "scripts/verify.sh"), TASK);
    expect(v.reasons).toEqual(
      expect.arrayContaining(["edited_graded_test", "weakened_the_gate"]),
    );
  });
});

describe("reading the patch", () => {
  it("names every file touched, reading the post-change side", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "+++ b/a.ts",
      "diff --git a/old.ts b/renamed.ts",
      "+++ b/renamed.ts",
    ].join("\n");
    expect(filesTouchedByPatch(patch).sort()).toEqual(["a.ts", "renamed.ts"]);
  });

  it("ignores /dev/null so a new file is not counted as a path", () => {
    expect(filesTouchedByPatch("--- /dev/null\n+++ b/new.ts")).toEqual(["new.ts"]);
  });

  it.each([
    ['+  it("x", () => {});', 1, 0],
    ['+  test("x", () => {});', 1, 0],
    ['+  describe("x", () => {});', 1, 0],
    ['+  it.each([1])("x", () => {});', 1, 0],
    ['-  it("x", () => {});', 0, 1],
    ["+  const inhabited = true;", 0, 0],
    ["+  visit(page);", 0, 0],
  ])("counts %s correctly", (line, added, removed) => {
    expect(countTestCaseDelta(line)).toEqual({ added, removed });
  });

  /* The +++/--- header lines are not content and counting them would make
     every patch look like it added and removed a test. */
  it("does not count diff headers as test cases", () => {
    expect(countTestCaseDelta("+++ b/it.test.ts\n--- a/it.test.ts")).toEqual({
      added: 0,
      removed: 0,
    });
  });
});

describe("the task corpus", () => {
  /* A task whose baseCommit already contains the fix hands the model the
     answer and measures transcription. A task whose graded test does not exist
     cannot grade anything. Both are silent failures that would produce a
     confident, meaningless leaderboard, so they are checked here rather than
     discovered halfway through a paid run. */
  it("every task names a real base commit, target file and graded test", () => {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const { existsSync } = require("node:fs") as typeof import("node:fs");
    const { TASKS } = require("@/lib/ai/code-screen-tasks") as typeof import("@/lib/ai/code-screen-tasks");

    expect(TASKS.length).toBeGreaterThan(0);
    for (const t of TASKS) {
      expect(() =>
        execFileSync("git", ["cat-file", "-e", `${t.baseCommit}^{commit}`], { stdio: "ignore" }),
      ).not.toThrow();
      for (const g of t.gradedBy) {
        /* The task id rides in the asserted value so a failure names the task
           rather than just saying false !== true. Jest's expect takes one
           argument; the message form is Vitest's. */
        expect(`${t.id}:${g}:${existsSync(g)}`).toBe(`${t.id}:${g}:true`);
      }
      /* The prompt must describe the PROBLEM. A prompt naming the solution
         measures whether a model can copy an instruction. */
      expect(t.prompt.length).toBeGreaterThan(120);
    }
  });

  it("gives every task a unique id, so results join cleanly across runs", () => {
    const { TASKS } = require("@/lib/ai/code-screen-tasks") as typeof import("@/lib/ai/code-screen-tasks");
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(TASKS.length);
  });
});
