/**
 * Reuse corpus store (factory brain part 1): the pure normalizer + the
 * write/read SQL layer over a mocked db. Proves we send the intended upsert,
 * degrade reads to [] / 0, and never persist blank/over-cap docs. Real-schema
 * persistence + idempotency is covered by factory-reuse-corpus.db.test.ts.
 */
const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));

import {
  normalizeDocs,
  rememberReuseCorpus,
  loadReuseCorpus,
  countReuseCorpus,
  MAX_CORPUS_WRITE,
} from "@/lib/ai-code/factory-reuse-store";

beforeEach(() => jest.clearAllMocks());

describe("normalizeDocs", () => {
  it("drops blank path/text, trims, dedupes by path (last wins), caps", () => {
    const out = normalizeDocs([
      { path: " a.ts ", text: " alpha " },
      { path: "a.ts", text: "alpha2" }, // dupe path -> last wins
      { path: "", text: "x" }, // no path
      { path: "b.ts", text: "" }, // no text
    ]);
    expect(out).toEqual([{ path: "a.ts", text: "alpha2" }]);
  });
  it("caps at MAX_CORPUS_WRITE", () => {
    const many = Array.from({ length: MAX_CORPUS_WRITE + 10 }, (_, i) => ({ path: `p${i}.ts`, text: `t${i}` }));
    expect(normalizeDocs(many).length).toBe(MAX_CORPUS_WRITE);
  });
});

describe("rememberReuseCorpus", () => {
  it("writes nothing (no query) when there are no usable docs", async () => {
    const r = await rememberReuseCorpus({ workspaceId: "w1", repo: "o/r", docs: [{ path: "", text: "" }] });
    expect(r.written).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("upserts normalized docs, workspace+repo scoped, embedded reset to false", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const r = await rememberReuseCorpus({
      workspaceId: "w1", repo: "o/r", commitSha: "abc",
      docs: [{ path: "src/a.ts", text: "a" }, { path: "src/b.ts", text: "b" }],
    });
    expect(r.written).toBe(2);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO instinct_factory_reuse_corpus/);
    expect(sql).toMatch(/ON CONFLICT \(workspace_id, repo, path\) DO UPDATE/);
    expect(sql).toMatch(/embedded = false/);
    expect(params.slice(0, 3)).toEqual(["w1", "o/r", "abc"]);
    expect(params).toContain("src/a.ts");
    expect(params).toContain("b");
  });

  it("propagates a write failure (never a silent corpus loss)", async () => {
    mockQuery.mockRejectedValue(new Error("db down"));
    await expect(
      rememberReuseCorpus({ workspaceId: "w1", repo: "o/r", docs: [{ path: "a.ts", text: "a" }] }),
    ).rejects.toThrow("db down");
  });
});

describe("loadReuseCorpus / countReuseCorpus (read, degrade to []/0)", () => {
  it("maps rows and is workspace+repo scoped", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [{ path: "a.ts", text: "a", commit_sha: "s", embedded: true, updated_at: "2026-10-04T00:00:00Z" }] });
    const rows = await loadReuseCorpus("w1", "o/r");
    expect(mockSafeQuery.mock.calls[0][1]).toEqual(["w1", "o/r"]);
    expect(rows[0]).toMatchObject({ path: "a.ts", repo: "o/r", commitSha: "s", embedded: true });
  });

  it("count returns 0 on empty/failure and scopes by repo when given", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    expect(await countReuseCorpus("w1")).toBe(0);
    mockSafeQuery.mockResolvedValue({ rows: [{ n: 42 }] });
    expect(await countReuseCorpus("w1", "o/r")).toBe(42);
    expect(mockSafeQuery.mock.calls[1][1]).toEqual(["w1", "o/r"]);
  });
});
