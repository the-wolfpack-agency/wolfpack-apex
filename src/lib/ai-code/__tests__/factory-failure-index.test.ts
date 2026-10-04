/**
 * indexFailureMemory + searchFailureMemory over injected deps. Same never-throw +
 * degrade contract as the reuse index; search returns the failure DESCRIPTION
 * (so the author can be warned), scoped by workspace+repo.
 */
import { indexFailureMemory, searchFailureMemory, type FailureIndexDeps } from "@/lib/ai-code/factory-failure-index";
import type { FailureRow } from "@/lib/ai-code/factory-failure-store";

const row = (signature: string, summary = signature): FailureRow => ({
  repo: "o/r", signature, findingClass: "logged_credential", summary, path: "src/x.ts", severity: "critical", timesSeen: 2, embedded: false, updatedAt: "t",
});

function deps(over: Partial<FailureIndexDeps> = {}): FailureIndexDeps {
  return {
    embed: jest.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
    qdrant: { url: "http://q" },
    loadUnembedded: jest.fn(async () => [row("sig1"), row("sig2")]),
    markEmbedded: jest.fn(async () => {}),
    ensure: jest.fn(async () => true),
    upsert: jest.fn(async () => true),
    search: jest.fn(async () => []),
    ...over,
  };
}

describe("indexFailureMemory", () => {
  it("embeds summaries, ensures the collection, upserts w/ rich payload, marks by signature", async () => {
    const d = deps();
    const r = await indexFailureMemory({ workspaceId: "w1", repo: "o/r", deps: d });
    expect(r.indexed).toBe(2);
    expect(d.ensure).toHaveBeenCalledWith(d.qdrant, "instinct_factory_failures", 3);
    const points = (d.upsert as jest.Mock).mock.calls[0][2];
    expect(points[0].payload).toMatchObject({ workspace_id: "w1", repo: "o/r", finding_class: "logged_credential", summary: "sig1" });
    expect(d.markEmbedded).toHaveBeenCalledWith("w1", "o/r", ["sig1", "sig2"]);
  });

  it("does NOT mark embedded when upsert fails (retry next tick)", async () => {
    const d = deps({ upsert: jest.fn(async () => false) });
    expect((await indexFailureMemory({ workspaceId: "w1", repo: "o/r", deps: d })).indexed).toBe(0);
    expect(d.markEmbedded).not.toHaveBeenCalled();
  });

  it("no-op when nothing unembedded / qdrant null / dep throws", async () => {
    expect((await indexFailureMemory({ workspaceId: "w1", repo: "o/r", deps: deps({ loadUnembedded: jest.fn(async () => []) }) })).indexed).toBe(0);
    expect((await indexFailureMemory({ workspaceId: "w1", repo: "o/r", deps: deps({ qdrant: null }) })).indexed).toBe(0);
    await expect(indexFailureMemory({ workspaceId: "w1", repo: "o/r", deps: deps({ embed: jest.fn(async () => { throw new Error("x"); }) }) })).resolves.toEqual({ indexed: 0 });
  });
});

describe("searchFailureMemory", () => {
  it("returns scoped failure descriptions for a task query", async () => {
    const d = deps({ search: jest.fn(async () => [
      { id: 1, score: 0.93, payload: { finding_class: "sql_injection", summary: "string-built query", path: "src/q.ts", severity: "high" } },
    ]) });
    const hits = await searchFailureMemory({ workspaceId: "w1", repo: "o/r", query: "add a query builder", deps: d });
    expect(hits).toEqual([{ findingClass: "sql_injection", summary: "string-built query", path: "src/q.ts", severity: "high", score: 0.93 }]);
    const [, , , must] = (d.search as jest.Mock).mock.calls[0];
    expect(must).toEqual({ workspace_id: "w1", repo: "o/r" });
  });
  it("drops payloads without a summary; [] on empty query / null qdrant / embedder miss", async () => {
    expect(await searchFailureMemory({ workspaceId: "w1", repo: "o/r", query: "x", deps: deps({ search: jest.fn(async () => [{ id: 1, score: 0.9, payload: {} }]) }) })).toEqual([]);
    expect(await searchFailureMemory({ workspaceId: "w1", repo: "o/r", query: "   ", deps: deps() })).toEqual([]);
    expect(await searchFailureMemory({ workspaceId: "w1", repo: "o/r", query: "x", deps: deps({ qdrant: null }) })).toEqual([]);
    expect(await searchFailureMemory({ workspaceId: "w1", repo: "o/r", query: "x", deps: deps({ embed: jest.fn(async () => []) }) })).toEqual([]);
  });
});
