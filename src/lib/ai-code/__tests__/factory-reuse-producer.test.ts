/**
 * Producer: repo tree -> corpus docs (pure) + rememberRepoTree never-throws
 * wrapper over the store (mocked). The REAL write-lands-in-Postgres proof is
 * factory-reuse-producer.db.test.ts (write via the real fn, read back).
 */
const mockRemember = jest.fn();
jest.mock("@/lib/ai-code/factory-reuse-store", () => ({
  rememberReuseCorpus: (...a: unknown[]) => mockRemember(...a),
}));

import { repoTreeToDocs, rememberRepoTree, MAX_PRODUCER_DOCS } from "@/lib/ai-code/factory-reuse-producer";

beforeEach(() => jest.clearAllMocks());

describe("repoTreeToDocs", () => {
  it("keeps source files, humanizes paths, drops tests/build + dupes", () => {
    const docs = repoTreeToDocs([
      "src/lib/cost-summary.ts",
      "src/lib/cost-summary.ts", // dupe
      "src/lib/__tests__/cost-summary.test.ts", // test -> dropped
      "README.md", // not code -> dropped
      "dist/bundle.js", // build -> dropped
    ]);
    expect(docs.map((d) => d.path)).toEqual(["src/lib/cost-summary.ts"]);
    expect(docs[0].text).toBe("src lib cost summary");
  });
  it("caps at MAX_PRODUCER_DOCS", () => {
    const big = Array.from({ length: MAX_PRODUCER_DOCS + 50 }, (_, i) => `src/m${i}.ts`);
    expect(repoTreeToDocs(big).length).toBe(MAX_PRODUCER_DOCS);
  });
});

describe("rememberRepoTree", () => {
  it("writes normalized docs through the store and returns the count", async () => {
    mockRemember.mockResolvedValue({ written: 1 });
    const r = await rememberRepoTree({ workspaceId: "w1", repo: "o/r", treePaths: ["src/a.ts"], commitSha: "abc" });
    expect(r.written).toBe(1);
    expect(mockRemember).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "w1", repo: "o/r", commitSha: "abc",
      docs: [{ path: "src/a.ts", text: "src a" }],
    }));
  });
  it("no store call + 0 when the tree has no reusable files", async () => {
    const r = await rememberRepoTree({ workspaceId: "w1", repo: "o/r", treePaths: ["README.md"] });
    expect(r.written).toBe(0);
    expect(mockRemember).not.toHaveBeenCalled();
  });
  it("never throws if the store throws (best-effort from a run)", async () => {
    mockRemember.mockRejectedValue(new Error("db down"));
    await expect(rememberRepoTree({ workspaceId: "w1", repo: "o/r", treePaths: ["src/a.ts"] }))
      .resolves.toEqual({ written: 0 });
  });
});
