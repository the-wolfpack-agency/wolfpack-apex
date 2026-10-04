/**
 * indexReuseCorpus + searchReuseCorpus orchestration over injected deps. Proves
 * the embed -> ensure -> upsert -> mark pipeline, that embedded is flipped ONLY
 * after vectors land, and that every failure path degrades (indexed:0 / []) and
 * never throws - a cold/down index must not break a run.
 */
import { indexReuseCorpus, searchReuseCorpus, type ReuseIndexDeps } from "@/lib/ai-code/factory-reuse-index";
import type { ReuseCorpusRow } from "@/lib/ai-code/factory-reuse-store";

const row = (path: string, text = path): ReuseCorpusRow => ({ path, text, repo: "o/r", commitSha: "s", embedded: false, updatedAt: "t" });

function deps(over: Partial<ReuseIndexDeps> = {}): ReuseIndexDeps {
  return {
    embed: jest.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
    qdrant: { url: "http://q" },
    loadUnembedded: jest.fn(async () => [row("src/a.ts"), row("src/b.ts")]),
    markEmbedded: jest.fn(async () => {}),
    ensure: jest.fn(async () => true),
    upsert: jest.fn(async () => true),
    search: jest.fn(async () => []),
    ...over,
  };
}

describe("indexReuseCorpus", () => {
  it("embeds, ensures the collection at the vector dim, upserts, then marks embedded", async () => {
    const d = deps();
    const r = await indexReuseCorpus({ workspaceId: "w1", repo: "o/r", deps: d });
    expect(r.indexed).toBe(2);
    expect(d.ensure).toHaveBeenCalledWith(d.qdrant, "instinct_factory_reuse", 3); // dim from the vector
    const points = (d.upsert as jest.Mock).mock.calls[0][2];
    expect(points[0].payload).toEqual({ workspace_id: "w1", repo: "o/r", path: "src/a.ts" });
    expect(d.markEmbedded).toHaveBeenCalledWith("w1", "o/r", ["src/a.ts", "src/b.ts"]);
  });

  it("does NOT mark embedded when the upsert fails (so it retries next time)", async () => {
    const d = deps({ upsert: jest.fn(async () => false) });
    const r = await indexReuseCorpus({ workspaceId: "w1", repo: "o/r", deps: d });
    expect(r.indexed).toBe(0);
    expect(d.markEmbedded).not.toHaveBeenCalled();
  });

  it("no-op when nothing is un-embedded", async () => {
    const d = deps({ loadUnembedded: jest.fn(async () => []) });
    expect((await indexReuseCorpus({ workspaceId: "w1", repo: "o/r", deps: d })).indexed).toBe(0);
    expect(d.embed).not.toHaveBeenCalled();
  });

  it("no-op (not throw) when Qdrant is unconfigured", async () => {
    const d = deps({ qdrant: null });
    expect((await indexReuseCorpus({ workspaceId: "w1", repo: "o/r", deps: d })).indexed).toBe(0);
  });

  it("degrades when the embedder returns a mismatched count", async () => {
    const d = deps({ embed: jest.fn(async () => [[0.1, 0.2]]) }); // 1 vec for 2 rows
    expect((await indexReuseCorpus({ workspaceId: "w1", repo: "o/r", deps: d })).indexed).toBe(0);
    expect(d.markEmbedded).not.toHaveBeenCalled();
  });

  it("never throws if a dep throws", async () => {
    const d = deps({ embed: jest.fn(async () => { throw new Error("boom"); }) });
    await expect(indexReuseCorpus({ workspaceId: "w1", repo: "o/r", deps: d })).resolves.toEqual({ indexed: 0 });
  });
});

describe("searchReuseCorpus", () => {
  it("embeds the query and returns scoped path hits", async () => {
    const d = deps({ search: jest.fn(async () => [
      { id: 1, score: 0.95, payload: { path: "src/a.ts" } },
      { id: 2, score: 0.80, payload: { path: "src/b.ts" } },
    ]) });
    const hits = await searchReuseCorpus({ workspaceId: "w1", repo: "o/r", query: "spending tracker", deps: d });
    expect(hits).toEqual([{ path: "src/a.ts", score: 0.95 }, { path: "src/b.ts", score: 0.80 }]);
    const [, , , must] = (d.search as jest.Mock).mock.calls[0];
    expect(must).toEqual({ workspace_id: "w1", repo: "o/r" });
  });

  it("drops hits without a path payload", async () => {
    const d = deps({ search: jest.fn(async () => [{ id: 1, score: 0.9, payload: {} }]) });
    expect(await searchReuseCorpus({ workspaceId: "w1", repo: "o/r", query: "x", deps: d })).toEqual([]);
  });

  it("[] on empty query (no embed call), null qdrant, or embedder miss", async () => {
    const d = deps();
    expect(await searchReuseCorpus({ workspaceId: "w1", repo: "o/r", query: "   ", deps: d })).toEqual([]);
    expect(d.embed).not.toHaveBeenCalled();
    expect(await searchReuseCorpus({ workspaceId: "w1", repo: "o/r", query: "x", deps: deps({ qdrant: null }) })).toEqual([]);
    expect(await searchReuseCorpus({ workspaceId: "w1", repo: "o/r", query: "x", deps: deps({ embed: jest.fn(async () => []) }) })).toEqual([]);
  });
});
