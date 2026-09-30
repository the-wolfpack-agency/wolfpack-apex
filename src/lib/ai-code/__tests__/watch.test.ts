/**
 * The autonomous watcher. The safety properties are the product: opt-in repos
 * only, factory/* PRs only, one bad PR never stalls the sweep.
 */
import { parseWatchRepos, runAiCodeWatch, type WatchPr } from "@/lib/ai-code/watch";
import { isFactoryBranch } from "@/lib/ai-code/revert";

describe("isFactoryBranch is the reused safety predicate (never touch a human's branch)", () => {
  it("true only for factory/* branches, which is what the watcher drives", () => {
    expect(isFactoryBranch("factory/feat-x-abc")).toBe(true);
    expect(isFactoryBranch("main")).toBe(false);
    expect(isFactoryBranch("feature/my-work")).toBe(false);
    expect(isFactoryBranch("hotfix/factory-thing")).toBe(false); // must be a prefix
  });
});

describe("parseWatchRepos (opt-in allowlist)", () => {
  it("parses valid owner/repo entries and drops junk", () => {
    expect(parseWatchRepos("a/b, c/d")).toEqual(["a/b", "c/d"]);
    expect(parseWatchRepos("not a repo, x/y")).toEqual(["x/y"]);
  });
  it("unset/empty => disabled (no repos)", () => {
    expect(parseWatchRepos(undefined)).toEqual([]);
    expect(parseWatchRepos("")).toEqual([]);
  });
});

const pr = (number: number, headRef: string, baseRef = "main"): WatchPr => ({ number, headRef, baseRef });

describe("runAiCodeWatch", () => {
  it("disabled when no repos are enrolled (never touches anything)", async () => {
    const drive = jest.fn();
    const s = await runAiCodeWatch({ repos: [], listPRs: jest.fn(), drive });
    expect(s.enabled).toBe(false);
    expect(drive).not.toHaveBeenCalled();
  });

  it("drives ONLY factory/* PRs, never a human's PR", async () => {
    const drive = jest.fn().mockResolvedValue({ action: "merge_ready", terminal: true });
    const listPRs = jest.fn().mockResolvedValue([pr(1, "factory/feat-a"), pr(2, "feature/human-work"), pr(3, "factory/feat-b")]);
    const s = await runAiCodeWatch({ repos: ["o/r"], listPRs, drive });
    expect(drive).toHaveBeenCalledTimes(2);
    expect(s.driven.map((d) => d.pr).sort()).toEqual([1, 3]);
    expect(s.driven.every((d) => d.terminal)).toBe(true);
  });

  it("isolates a per-PR failure so one bad PR never stalls the sweep", async () => {
    const drive = jest
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ action: "wait", terminal: false });
    const listPRs = jest.fn().mockResolvedValue([pr(1, "factory/a"), pr(2, "factory/b")]);
    const s = await runAiCodeWatch({ repos: ["o/r"], listPRs, drive });
    expect(s.errors).toEqual([{ repo: "o/r", pr: 1, error: "boom" }]);
    expect(s.driven).toEqual([{ repo: "o/r", pr: 2, action: "wait", terminal: false }]);
  });

  it("a repo it cannot read is skipped, not fatal", async () => {
    const drive = jest.fn().mockResolvedValue({ action: "wait", terminal: false });
    const listPRs = jest.fn()
      .mockRejectedValueOnce(new Error("403"))
      .mockResolvedValueOnce([pr(9, "factory/z")]);
    const s = await runAiCodeWatch({ repos: ["o/bad", "o/good"], listPRs, drive });
    expect(s.driven.map((d) => d.pr)).toEqual([9]);
  });
});
