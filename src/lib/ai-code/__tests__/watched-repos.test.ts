/**
 * Watched-repos config: the pure pieces (validation + env/DB merge). The SaaS
 * point is that enrollment is per-workspace data; env is only a bootstrap.
 */
import { isValidRepo, mergeWatchTargets, SELF_REPO } from "@/lib/ai-code/watched-repos";

/** Our own repo is always appended under the resolved workspace (self-maintaining). */
const self = (ws: string) => ({ workspaceId: ws, repo: SELF_REPO });

describe("isValidRepo", () => {
  it("accepts owner/name, rejects junk", () => {
    expect(isValidRepo("the-wolfpack-agency/wolfpack-cayenne-e4")).toBe(true);
    expect(isValidRepo("no-slash")).toBe(false);
    expect(isValidRepo("bad name/x")).toBe(false);
    expect(isValidRepo("")).toBe(false);
  });
});

describe("mergeWatchTargets (DB is source of truth; env is an additive bootstrap)", () => {
  it("returns DB targets with their workspace (+ always self-watches our repo)", () => {
    const r = mergeWatchTargets([{ workspaceId: "w1", repo: "o/a" }, { workspaceId: "w2", repo: "o/b" }], undefined, undefined);
    expect(r).toEqual([{ workspaceId: "w1", repo: "o/a" }, { workspaceId: "w2", repo: "o/b" }, self("default")]);
  });

  it("adds env repos under the env workspace (or 'default')", () => {
    expect(mergeWatchTargets([], "o/x, o/y", "w9")).toEqual([{ workspaceId: "w9", repo: "o/x" }, { workspaceId: "w9", repo: "o/y" }, self("w9")]);
    expect(mergeWatchTargets([], "o/z", undefined)).toEqual([{ workspaceId: "default", repo: "o/z" }, self("default")]);
  });

  it("dedupes across DB and env by (workspace, repo)", () => {
    const r = mergeWatchTargets([{ workspaceId: "w1", repo: "o/a" }], "o/a", "w1");
    expect(r).toEqual([{ workspaceId: "w1", repo: "o/a" }, self("w1")]);
  });

  it("drops malformed env repos", () => {
    expect(mergeWatchTargets([], "not a repo, o/ok", "w1")).toEqual([{ workspaceId: "w1", repo: "o/ok" }, self("w1")]);
  });

  it("ALWAYS self-watches our own repo, with no env var, and dedupes if also enrolled", () => {
    // no DB, no env -> still watches our own repo under 'default'
    expect(mergeWatchTargets([], undefined, undefined)).toEqual([self("default")]);
    // explicitly enrolling SELF_REPO under the same workspace does not duplicate it
    const r = mergeWatchTargets([{ workspaceId: "default", repo: SELF_REPO }], undefined, undefined);
    expect(r).toEqual([self("default")]);
  });
});
