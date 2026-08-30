/**
 * The orphan check, against the incident that produced it.
 *
 * 2026-08-30: #576 was opened with #575's branch as its base, merged into that
 * branch, and then #575 was squash-merged into main. Both showed as merged.
 * #576's files were not in main. That exact shape is the first test here.
 */
import { classifyMerges, orphansOf, describe as report, type MergedPr } from "../merge-orphans";

const pr = (over: Partial<MergedPr> = {}): MergedPr => ({
  number: 576,
  title: "Infer business objects from urls and forms",
  baseRefName: "feat/sample-repeated-shapes",
  addedFiles: ["src/lib/platform-scan/mapping/entities.ts"],
  ...over,
});

/** Nothing the stacked PR added made it into main. */
const emptyMain = () => false;
const fullMain = () => true;

describe("classifying merged pull requests", () => {
  it("catches the real incident: merged into a branch that was then squashed", () => {
    const [v] = classifyMerges([pr()], "main", emptyMain);
    expect(v.state).toBe("orphaned");
  });

  it("says which files are missing, so recovery is not an investigation", () => {
    const [v] = classifyMerges([pr()], "main", emptyMain);
    expect(v.state === "orphaned" && v.missing).toEqual([
      "src/lib/platform-scan/mapping/entities.ts",
    ]);
  });

  it("passes a stacked PR whose files did land", () => {
    expect(classifyMerges([pr()], "main", fullMain)[0].state).toBe("in-main");
  });

  it("does not check a PR merged straight to the default branch", () => {
    const [v] = classifyMerges([pr({ baseRefName: "main" })], "main", emptyMain);
    expect(v.state).toBe("direct");
  });

  /* SOME missing is a rename or a later move. Flagging those would produce
     noise every week, and a check people ignore protects nothing. */
  it("does not flag a PR that is only partly present", () => {
    const partly = pr({ addedFiles: ["kept.ts", "moved-later.ts"] });
    const [v] = classifyMerges([partly], "main", (f) => f === "kept.ts");
    expect(v.state).toBe("in-main");
  });

  /* REPORTED, NOT PASSED. A stacked PR that only edited existing files can be
     just as orphaned and this method cannot see it. Calling that a pass would
     make the check look more complete than it is. */
  it("admits when it cannot decide rather than passing quietly", () => {
    const [v] = classifyMerges([pr({ addedFiles: [] })], "main", emptyMain);
    expect(v.state).toBe("unverifiable");
    expect(v.state === "unverifiable" && v.because).toMatch(/added no new files/);
  });

  it("works on a repo whose default branch is not called main", () => {
    const [v] = classifyMerges([pr({ baseRefName: "trunk" })], "trunk", emptyMain);
    expect(v.state).toBe("direct");
  });

  it("finds nothing in an empty list", () => {
    expect(orphansOf(classifyMerges([], "main", emptyMain))).toEqual([]);
  });
});

describe("what it tells somebody", () => {
  it("names the PR, the branch, and how to get the work back", () => {
    const text = report(classifyMerges([pr()], "main", emptyMain), "main");
    expect(text).toContain("#576");
    expect(text).toContain("feat/sample-repeated-shapes");
    expect(text).toMatch(/cherry-pick/);
  });

  it("explains the cause, because the badge says merged and people trust it", () => {
    const text = report(classifyMerges([pr()], "main", emptyMain), "main");
    expect(text).toMatch(/squash/i);
  });

  /* How much of the list was actually checked is said every run, not only when
     something is wrong. */
  it("says how many it could not check, even when nothing is orphaned", () => {
    const text = report(classifyMerges([pr({ addedFiles: [] })], "main", fullMain), "main");
    expect(text).toMatch(/No orphaned merges/);
    expect(text).toMatch(/could not be checked/);
  });

  it("is quiet when everything landed", () => {
    const text = report(classifyMerges([pr()], "main", fullMain), "main");
    expect(text).toMatch(/No orphaned merges/);
    expect(text).not.toMatch(/could not be checked/);
  });
});
