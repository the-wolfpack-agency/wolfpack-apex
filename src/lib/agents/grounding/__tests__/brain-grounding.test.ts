/**
 * Brain grounding tests. The embedder gate and the Brain query are injected so
 * we prove the deterministic-first + graceful-degradation contract without a
 * live Brain, embedder, or database:
 *   - embeddings unconfigured -> empty grounding, queryBrain NEVER called (zero
 *     cost; a reuse-style run never pays).
 *   - hits map to truncated snippets on success.
 *   - a thrown queryBrain is swallowed into an empty grounding (never throws).
 *   - the query is workspace-scoped.
 */

import { groundFromBrain } from "@/lib/agents/grounding/brain-grounding";

function hit(snippet: string, content = "") {
  return {
    chunk_id: "c1",
    document_id: "d1",
    document_filename: "f.md",
    document_kind: "other",
    chunk_idx: 0,
    content,
    score: 0.9,
    source: "keyword" as const,
    snippet,
  };
}

describe("groundFromBrain", () => {
  it("returns empty grounding and NEVER queries when embeddings are unconfigured", async () => {
    const queryBrain = jest.fn();
    const out = await groundFromBrain("ship the thing", "ws-1", {
      isEmbeddingConfigured: () => false,
      queryBrain: queryBrain as never,
    });
    expect(out).toEqual({ used: false, hits: 0, snippets: [] });
    // Zero cost: the Brain was not consulted at all.
    expect(queryBrain).not.toHaveBeenCalled();
  });

  it("returns empty grounding for an empty goal without querying", async () => {
    const queryBrain = jest.fn();
    const out = await groundFromBrain("   ", "ws-1", {
      isEmbeddingConfigured: () => true,
      queryBrain: queryBrain as never,
    });
    expect(out).toEqual({ used: false, hits: 0, snippets: [] });
    expect(queryBrain).not.toHaveBeenCalled();
  });

  it("maps Brain hits to truncated snippets on success", async () => {
    const long = "x".repeat(400);
    const queryBrain = jest.fn().mockResolvedValue({
      hits: [hit("alpha knowledge"), hit("", long), hit("gamma")],
    });
    const out = await groundFromBrain("known goal", "ws-1", {
      isEmbeddingConfigured: () => true,
      queryBrain: queryBrain as never,
    });
    expect(out.used).toBe(true);
    expect(out.hits).toBe(3);
    expect(out.snippets[0]).toBe("alpha knowledge");
    // The hit with no snippet falls back to content, truncated with an ellipsis.
    expect(out.snippets[1].length).toBeLessThanOrEqual(280);
    expect(out.snippets[1].endsWith("…")).toBe(true);
    expect(out.snippets[2]).toBe("gamma");
  });

  it("drops empty snippets but still reports the raw hit count", async () => {
    const queryBrain = jest.fn().mockResolvedValue({
      hits: [hit("", ""), hit("real")],
    });
    const out = await groundFromBrain("goal", "ws-1", {
      isEmbeddingConfigured: () => true,
      queryBrain: queryBrain as never,
    });
    expect(out.used).toBe(true);
    expect(out.hits).toBe(2);
    expect(out.snippets).toEqual(["real"]);
  });

  it("swallows a thrown queryBrain into an empty grounding (never throws)", async () => {
    const queryBrain = jest.fn().mockRejectedValue(new Error("brain down"));
    const out = await groundFromBrain("goal", "ws-1", {
      isEmbeddingConfigured: () => true,
      queryBrain: queryBrain as never,
    });
    expect(out).toEqual({ used: false, hits: 0, snippets: [] });
  });

  it("scopes the query to the workspace and passes a workspace actor", async () => {
    const queryBrain = jest.fn().mockResolvedValue({ hits: [] });
    await groundFromBrain("scoped goal", "ws-42", {
      isEmbeddingConfigured: () => true,
      queryBrain: queryBrain as never,
    });
    const arg = queryBrain.mock.calls[0][0];
    expect(arg.workspaceId).toBe("ws-42");
    expect(arg.query).toBe("scoped goal");
    expect(arg.limit).toBe(3);
    // The audit actor is workspace-scoped (defaults derived from the workspace).
    expect(arg.userId).toContain("ws-42");
    expect(arg.userRole).toBe("agent");
  });

  it("uses an explicit actor identity when provided", async () => {
    const queryBrain = jest.fn().mockResolvedValue({ hits: [] });
    await groundFromBrain("goal", "ws-1", {
      isEmbeddingConfigured: () => true,
      queryBrain: queryBrain as never,
      userId: "agent-7",
      userRole: "ops",
    });
    const arg = queryBrain.mock.calls[0][0];
    expect(arg.userId).toBe("agent-7");
    expect(arg.userRole).toBe("ops");
  });

  it("tolerates a result with no hits array", async () => {
    const queryBrain = jest.fn().mockResolvedValue({});
    const out = await groundFromBrain("goal", "ws-1", {
      isEmbeddingConfigured: () => true,
      queryBrain: queryBrain as never,
    });
    expect(out).toEqual({ used: true, hits: 0, snippets: [] });
  });
});
