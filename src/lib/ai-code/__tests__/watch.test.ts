/**
 * The autonomous watcher. The safety properties are the product: enrolled targets
 * only, factory/* PRs only, per-workspace, one bad PR never stalls the sweep.
 */
import { runAiCodeWatch, type WatchPr, type WatchTarget } from "@/lib/ai-code/watch";
import { isFactoryBranch } from "@/lib/ai-code/revert";

describe("isFactoryBranch is the reused safety predicate (never touch a human's branch)", () => {
  it("true only for factory/* branches, which is what the watcher drives", () => {
    expect(isFactoryBranch("factory/feat-x-abc")).toBe(true);
    expect(isFactoryBranch("main")).toBe(false);
    expect(isFactoryBranch("feature/my-work")).toBe(false);
    expect(isFactoryBranch("hotfix/factory-thing")).toBe(false); // must be a prefix
  });
});

const t = (workspaceId: string, repo: string): WatchTarget => ({ workspaceId, repo });
const pr = (number: number, headRef: string, baseRef = "main"): WatchPr => ({ number, headRef, baseRef });

describe("runAiCodeWatch", () => {
  it("disabled when no targets are enrolled (never touches anything)", async () => {
    const drive = jest.fn();
    const s = await runAiCodeWatch({ targets: [], listPRs: jest.fn(), drive });
    expect(s.enabled).toBe(false);
    expect(drive).not.toHaveBeenCalled();
  });

  it("drives ONLY factory/* PRs, never a human's PR, and carries the workspace", async () => {
    const drive = jest.fn().mockResolvedValue({ action: "merge_ready", terminal: true });
    const listPRs = jest.fn().mockResolvedValue([pr(1, "factory/feat-a"), pr(2, "feature/human-work"), pr(3, "factory/feat-b")]);
    const s = await runAiCodeWatch({ targets: [t("w1", "o/r")], listPRs, drive });
    expect(drive).toHaveBeenCalledTimes(2);
    expect(s.driven.map((d) => d.pr).sort()).toEqual([1, 3]);
    expect(s.driven.every((d) => d.workspaceId === "w1" && d.terminal)).toBe(true);
  });

  it("drives multiple workspaces, each with its own target", async () => {
    const drive = jest.fn().mockResolvedValue({ action: "wait", terminal: false });
    const listPRs = jest.fn().mockResolvedValue([pr(1, "factory/a")]);
    const s = await runAiCodeWatch({ targets: [t("w1", "o/r1"), t("w2", "o/r2")], listPRs, drive });
    expect(s.driven.map((d) => d.workspaceId).sort()).toEqual(["w1", "w2"]);
  });

  it("isolates a per-PR failure so one bad PR never stalls the sweep", async () => {
    const drive = jest
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ action: "wait", terminal: false });
    const listPRs = jest.fn().mockResolvedValue([pr(1, "factory/a"), pr(2, "factory/b")]);
    const s = await runAiCodeWatch({ targets: [t("w1", "o/r")], listPRs, drive });
    expect(s.errors).toEqual([{ workspaceId: "w1", repo: "o/r", pr: 1, error: "boom" }]);
    expect(s.driven).toEqual([{ workspaceId: "w1", repo: "o/r", pr: 2, action: "wait", terminal: false }]);
  });

  it("a target it cannot read is skipped, not fatal", async () => {
    const drive = jest.fn().mockResolvedValue({ action: "wait", terminal: false });
    const listPRs = jest.fn()
      .mockRejectedValueOnce(new Error("403"))
      .mockResolvedValueOnce([pr(9, "factory/z")]);
    const s = await runAiCodeWatch({ targets: [t("w1", "o/bad"), t("w1", "o/good")], listPRs, drive });
    expect(s.driven.map((d) => d.pr)).toEqual([9]);
  });
});
