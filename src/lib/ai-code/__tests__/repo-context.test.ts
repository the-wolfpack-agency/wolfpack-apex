/**
 * Repo-aware context: extract prompt-named paths, fetch their contents, build a
 * bounded context block. github-client (fetchFileContent) is mocked.
 */
const mockFetchFile = jest.fn();
jest.mock("@/lib/github-client", () => ({ fetchFileContent: (...a: unknown[]) => mockFetchFile(...a) }));

import { extractMentionedPaths, buildRepoContext, withRepoContext } from "@/lib/ai-code/repo-context";

beforeEach(() => jest.clearAllMocks());

describe("extractMentionedPaths", () => {
  it("finds code-like paths a prompt names, in order, deduped", () => {
    const paths = extractMentionedPaths("Add rate limiting to src/app/api/auth/login/route.ts and update src/lib/rate.ts, again src/lib/rate.ts");
    expect(paths).toEqual(["src/app/api/auth/login/route.ts", "src/lib/rate.ts"]);
  });
  it("ignores non-code tokens and prose", () => {
    expect(extractMentionedPaths("Make the login flow faster and add tests")).toEqual([]);
  });
  it("never yields a path with .. traversal", () => {
    const p = extractMentionedPaths("read ../../etc/passwd.ts and src/a.ts");
    expect(p.every((x) => !x.includes(".."))).toBe(true);
  });
  it("caps the number of paths", () => {
    const p = extractMentionedPaths("a.ts b.ts c.ts d.ts e.ts f.ts g.ts", 3);
    expect(p).toHaveLength(3);
  });
});

describe("buildRepoContext", () => {
  const client = { token: "t", fetch: jest.fn() } as never;

  it("fetches named files that exist and builds a block naming each", async () => {
    mockFetchFile.mockImplementation((_c, _r, path) => Promise.resolve(path === "src/lib/rate.ts" ? "export const rate = 1;" : null));
    const ctx = await buildRepoContext({ client, repo: "o/r", prompt: "edit src/lib/rate.ts and src/lib/missing.ts" });
    expect(ctx.files).toEqual(["src/lib/rate.ts"]); // missing (404 -> null) skipped
    expect(ctx.block).toContain("FILE: src/lib/rate.ts");
    expect(ctx.block).toContain("export const rate = 1;");
  });

  it("returns empty when the prompt names no paths (no fetch)", async () => {
    const ctx = await buildRepoContext({ client, repo: "o/r", prompt: "add a helper" });
    expect(ctx).toEqual({ block: "", files: [] });
    expect(mockFetchFile).not.toHaveBeenCalled();
  });

  it("respects the byte budget", async () => {
    mockFetchFile.mockResolvedValue("x".repeat(50));
    const ctx = await buildRepoContext({ client, repo: "o/r", prompt: "a.ts b.ts c.ts", maxBytes: 60 });
    expect(ctx.files.length).toBeLessThan(3); // budget stops it before all three
  });

  it("never throws on a fetch error (best-effort)", async () => {
    mockFetchFile.mockRejectedValue(new Error("boom"));
    const ctx = await buildRepoContext({ client, repo: "o/r", prompt: "edit src/a.ts" });
    expect(ctx).toEqual({ block: "", files: [] });
  });
});

describe("withRepoContext", () => {
  it("prepends the block and keeps the task", () => {
    expect(withRepoContext("do X", "CONTEXT")).toContain("CONTEXT");
    expect(withRepoContext("do X", "CONTEXT")).toContain("do X");
  });
  it("is a no-op when the block is empty", () => {
    expect(withRepoContext("do X", "")).toBe("do X");
  });
});
