/**
 * Tests for the dual-write orchestrator. Verifies:
 *   - No throws in any failure path (hard rule).
 *   - Correct per-mode behavior (primary_only / shadow / compare / both).
 *   - Analytics events fire with the right event names and payload shape
 *     so the learning loop gets a complete signal.
 *   - Divergence is computed correctly for both counts (vector) and
 *     boolean-success (graph).
 */

import type {
  GraphNode,
  GraphStore,
  VectorDoc,
  VectorSearchHit,
  VectorSearchOptions,
  VectorStore,
} from "@/lib/rag-providers/types";

// Mock the shim before importing the module under test so the import
// wires up against our jest.fn.
jest.mock("@/lib/rag-providers/analytics-shim", () => ({
  emitRagEvent: jest.fn(),
}));

import { emitRagEvent } from "@/lib/rag-providers/analytics-shim";
import {
  dualReadVector,
  dualWriteGraphNode,
  dualWriteVector,
} from "@/lib/rag-providers/dual-write";

const emitMock = emitRagEvent as jest.MockedFunction<typeof emitRagEvent>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkVectorStore(name: string, overrides: Partial<VectorStore> = {}): VectorStore {
  return {
    name,
    upsert: jest.fn(async () => ({ written: 0 })),
    search: jest.fn(async () => [] as VectorSearchHit[]),
    delete: jest.fn(async () => ({ deleted: 0 })),
    health: jest.fn(async () => ({ ok: true, latencyMs: 0 })),
    ...overrides,
  };
}

function mkGraphStore(name: string, overrides: Partial<GraphStore> = {}): GraphStore {
  return {
    name,
    upsertNode: jest.fn(async () => undefined),
    upsertEdge: jest.fn(async () => undefined),
    query: jest.fn(async () => []),
    health: jest.fn(async () => ({ ok: true, latencyMs: 0 })),
    ...overrides,
  };
}

function mkDoc(id: string): VectorDoc {
  return {
    id,
    text: `doc-${id}`,
    metadata: {},
    tenantId: "tenant-a",
  };
}

function mkHit(id: string, score = 0.9): VectorSearchHit {
  return { id, text: `hit-${id}`, score, metadata: {} };
}

/** Find every call for a given event name. */
function calls(eventName: string): Array<{ userId: string; role: string; payload: Record<string, unknown> }> {
  return emitMock.mock.calls
    .filter(([name]) => name === eventName)
    .map(([, userId, role, payload]) => ({
      userId: userId as string,
      role: role as string,
      payload: payload as Record<string, unknown>,
    }));
}

function eventCount(eventName: string): number {
  return calls(eventName).length;
}

beforeEach(() => {
  emitMock.mockReset();
});

// ---------------------------------------------------------------------------
// dualWriteVector
// ---------------------------------------------------------------------------

describe("dualWriteVector", () => {
  it("emits per-side ok events and no divergence when counts match", async () => {
    const primary = mkVectorStore("qdrant", {
      upsert: jest.fn(async () => ({ written: 3 })),
    });
    const secondary = mkVectorStore("azure_ai_search", {
      upsert: jest.fn(async () => ({ written: 3 })),
    });

    const docs = [mkDoc("a"), mkDoc("b"), mkDoc("c")];
    const result = await dualWriteVector(primary, secondary, docs, "both");

    expect(result.primary.written).toBe(3);
    expect(result.secondary).toEqual({ written: 3 });
    expect(result.divergence).toBe(false);

    expect(primary.upsert).toHaveBeenCalledWith(docs);
    expect(secondary.upsert).toHaveBeenCalledWith(docs);

    expect(eventCount("rag.dual_write_started")).toBe(1);
    expect(eventCount("rag.vector_upsert_ok")).toBe(2);
    expect(eventCount("rag.dual_write_divergence")).toBe(0);
    expect(eventCount("rag.dual_write_failed")).toBe(0);
    expect(eventCount("rag.dual_write_completed")).toBe(1);
  });

  it("emits rag.dual_write_divergence when counts differ", async () => {
    const primary = mkVectorStore("qdrant", {
      upsert: jest.fn(async () => ({ written: 5 })),
    });
    const secondary = mkVectorStore("azure_ai_search", {
      upsert: jest.fn(async () => ({ written: 4 })),
    });

    const result = await dualWriteVector(
      primary,
      secondary,
      [mkDoc("a"), mkDoc("b"), mkDoc("c"), mkDoc("d"), mkDoc("e")],
      "both",
    );

    expect(result.divergence).toBe(true);

    const div = calls("rag.dual_write_divergence");
    expect(div).toHaveLength(1);
    expect(div[0].payload).toMatchObject({
      primary: "qdrant",
      secondary: "azure_ai_search",
      primary_written: 5,
      secondary_written: 4,
      mode: "both",
    });
  });

  it("emits rag.dual_write_failed for the failing side and primary still succeeds", async () => {
    const primary = mkVectorStore("qdrant", {
      upsert: jest.fn(async () => ({ written: 2 })),
    });
    const secondary = mkVectorStore("azure_ai_search", {
      upsert: jest.fn(async () => {
        throw new Error("azure-down");
      }),
    });

    const result = await dualWriteVector(
      primary,
      secondary,
      [mkDoc("a"), mkDoc("b")],
      "both",
    );

    expect(result.primary.written).toBe(2);
    expect(result.secondary).toBeNull();
    // Divergence only emits when BOTH sides produced a count — a
    // secondary failure is surfaced via dual_write_failed, not silently
    // turned into a divergence.
    expect(result.divergence).toBe(false);
    expect(eventCount("rag.dual_write_divergence")).toBe(0);

    const failed = calls("rag.dual_write_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].payload).toMatchObject({
      target: "azure_ai_search",
      side: "secondary",
      error: "azure-down",
    });

    const upsertFailed = calls("rag.vector_upsert_failed");
    expect(upsertFailed).toHaveLength(1);
    expect(upsertFailed[0].payload.target).toBe("azure_ai_search");
  });

  it("does not throw when the primary fails; emits failed events", async () => {
    const primary = mkVectorStore("qdrant", {
      upsert: jest.fn(async () => {
        throw new Error("qdrant-down");
      }),
    });
    const secondary = mkVectorStore("azure_ai_search", {
      upsert: jest.fn(async () => ({ written: 1 })),
    });

    await expect(
      dualWriteVector(primary, secondary, [mkDoc("a")], "both"),
    ).resolves.toMatchObject({
      primary: { written: 0 },
      secondary: { written: 1 },
    });

    const failed = calls("rag.dual_write_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].payload).toMatchObject({
      target: "qdrant",
      side: "primary",
      error: "qdrant-down",
    });

    const upsertFailed = calls("rag.vector_upsert_failed");
    expect(upsertFailed).toHaveLength(1);
    expect(upsertFailed[0].payload.target).toBe("qdrant");
  });

  it("primary_only mode does not call secondary", async () => {
    const primary = mkVectorStore("qdrant", {
      upsert: jest.fn(async () => ({ written: 2 })),
    });
    const secondary = mkVectorStore("azure_ai_search", {
      upsert: jest.fn(async () => ({ written: 99 })),
    });

    const result = await dualWriteVector(
      primary,
      secondary,
      [mkDoc("a"), mkDoc("b")],
      "primary_only",
    );

    expect(secondary.upsert).not.toHaveBeenCalled();
    expect(result.secondary).toBeNull();
    expect(result.divergence).toBe(false);

    // Exactly one ok event — primary only.
    expect(eventCount("rag.vector_upsert_ok")).toBe(1);
  });

  it("tolerates a null secondary without ever trying to call it", async () => {
    const primary = mkVectorStore("qdrant", {
      upsert: jest.fn(async () => ({ written: 1 })),
    });

    const result = await dualWriteVector(primary, null, [mkDoc("a")], "both");

    expect(result.secondary).toBeNull();
    expect(result.divergence).toBe(false);
    expect(eventCount("rag.dual_write_failed")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// dualReadVector
// ---------------------------------------------------------------------------

describe("dualReadVector", () => {
  const searchOpts: VectorSearchOptions = {
    query: "hello",
    tenantId: "tenant-a",
    topK: 3,
  };

  it("primary_only: does not call secondary, returns primary hits", async () => {
    const primary = mkVectorStore("qdrant", {
      search: jest.fn(async () => [mkHit("1"), mkHit("2")]),
    });
    const secondary = mkVectorStore("azure_ai_search", {
      search: jest.fn(async () => [mkHit("99")]),
    });

    const hits = await dualReadVector(primary, secondary, searchOpts, "primary_only");

    expect(hits).toHaveLength(2);
    expect(secondary.search).not.toHaveBeenCalled();
    expect(eventCount("rag.dual_read_divergence")).toBe(0);
  });

  it("shadow: returns primary hits, still calls secondary, emits divergence on id-set diff", async () => {
    const primary = mkVectorStore("qdrant", {
      search: jest.fn(async () => [mkHit("1"), mkHit("2")]),
    });
    const secondary = mkVectorStore("azure_ai_search", {
      search: jest.fn(async () => [mkHit("1"), mkHit("3")]),
    });

    const hits = await dualReadVector(primary, secondary, searchOpts, "shadow");

    // Primary hits returned to caller unchanged.
    expect(hits.map((h) => h.id)).toEqual(["1", "2"]);
    expect(secondary.search).toHaveBeenCalledWith(searchOpts);

    const div = calls("rag.dual_read_divergence");
    expect(div).toHaveLength(1);
    expect(div[0].payload).toMatchObject({
      primary: "qdrant",
      secondary: "azure_ai_search",
      primary_ids: ["1", "2"],
      secondary_ids: ["1", "3"],
      intersection: 1,
      primary_only: 1,
      secondary_only: 1,
      mode: "shadow",
    });
  });

  it("shadow: does NOT emit divergence when id-sets are identical (signal conservation)", async () => {
    const primary = mkVectorStore("qdrant", {
      search: jest.fn(async () => [mkHit("1"), mkHit("2")]),
    });
    const secondary = mkVectorStore("azure_ai_search", {
      search: jest.fn(async () => [mkHit("2"), mkHit("1")]), // order ignored
    });

    await dualReadVector(primary, secondary, searchOpts, "shadow");

    expect(eventCount("rag.dual_read_divergence")).toBe(0);
  });

  it("compare: ALWAYS emits divergence event, even on identical id-sets (baseline)", async () => {
    const primary = mkVectorStore("qdrant", {
      search: jest.fn(async () => [mkHit("1"), mkHit("2")]),
    });
    const secondary = mkVectorStore("azure_ai_search", {
      search: jest.fn(async () => [mkHit("1"), mkHit("2")]),
    });

    await dualReadVector(primary, secondary, searchOpts, "compare");

    const div = calls("rag.dual_read_divergence");
    expect(div).toHaveLength(1);
    expect(div[0].payload).toMatchObject({
      primary_only: 0,
      secondary_only: 0,
      intersection: 2,
      mode: "compare",
    });
  });

  it("returns [] and emits rag.vector_query_failed when primary read throws; never throws", async () => {
    const primary = mkVectorStore("qdrant", {
      search: jest.fn(async () => {
        throw new Error("read-failed");
      }),
    });

    const hits = await dualReadVector(primary, null, searchOpts, "primary_only");

    expect(hits).toEqual([]);
    const failed = calls("rag.vector_query_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].payload).toMatchObject({
      target: "qdrant",
      side: "primary",
      error: "read-failed",
    });
  });
});

// ---------------------------------------------------------------------------
// dualWriteGraphNode
// ---------------------------------------------------------------------------

describe("dualWriteGraphNode", () => {
  const node: GraphNode = {
    id: "n1",
    labels: ["Doc"],
    props: { title: "t" },
    tenantId: "tenant-a",
  };

  it("happy path: both succeed, no divergence", async () => {
    const primary = mkGraphStore("neo4j");
    const secondary = mkGraphStore("age");

    const result = await dualWriteGraphNode(primary, secondary, node, "both");

    expect(result.divergence).toBe(false);
    expect(primary.upsertNode).toHaveBeenCalledWith(node);
    expect(secondary.upsertNode).toHaveBeenCalledWith(node);

    expect(eventCount("rag.graph_upsert_ok")).toBe(2);
    expect(eventCount("rag.dual_write_divergence")).toBe(0);
    expect(eventCount("rag.dual_write_failed")).toBe(0);
  });

  it("emits divergence + failed when secondary fails and primary succeeds", async () => {
    const primary = mkGraphStore("neo4j");
    const secondary = mkGraphStore("age", {
      upsertNode: jest.fn(async () => {
        throw new Error("age-down");
      }),
    });

    const result = await dualWriteGraphNode(primary, secondary, node, "both");

    expect(result.divergence).toBe(true);

    const failed = calls("rag.dual_write_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].payload).toMatchObject({
      target: "age",
      side: "secondary",
      kind: "graph_node",
      error: "age-down",
    });

    const div = calls("rag.dual_write_divergence");
    expect(div).toHaveLength(1);
    expect(div[0].payload).toMatchObject({
      kind: "graph_node",
      node_id: "n1",
      primary_ok: true,
      secondary_ok: false,
    });
  });

  it("primary failure alone does not throw; emits failed; divergence fires", async () => {
    const primary = mkGraphStore("neo4j", {
      upsertNode: jest.fn(async () => {
        throw new Error("neo-down");
      }),
    });
    const secondary = mkGraphStore("age");

    await expect(
      dualWriteGraphNode(primary, secondary, node, "both"),
    ).resolves.toEqual({ divergence: true });

    const failed = calls("rag.dual_write_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].payload.target).toBe("neo4j");
  });

  it("both sides fail: emits two failed events but NOT a divergence event", async () => {
    const primary = mkGraphStore("neo4j", {
      upsertNode: jest.fn(async () => {
        throw new Error("neo-down");
      }),
    });
    const secondary = mkGraphStore("age", {
      upsertNode: jest.fn(async () => {
        throw new Error("age-down");
      }),
    });

    const result = await dualWriteGraphNode(primary, secondary, node, "both");
    expect(result.divergence).toBe(false);
    expect(eventCount("rag.dual_write_failed")).toBe(2);
    expect(eventCount("rag.dual_write_divergence")).toBe(0);
  });

  it("primary_only skips secondary entirely", async () => {
    const primary = mkGraphStore("neo4j");
    const secondary = mkGraphStore("age");

    await dualWriteGraphNode(primary, secondary, node, "primary_only");

    expect(secondary.upsertNode).not.toHaveBeenCalled();
    expect(eventCount("rag.graph_upsert_ok")).toBe(1);
  });
});
