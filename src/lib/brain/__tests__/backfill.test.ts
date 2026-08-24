/**
 * The backfill must never report work it did not do.
 *
 * The bug it exists to repair was exactly that shape: embeddings were skipped
 * silently for the life of the feature, and every surface reported health.
 */
const mockQuery = jest.fn();
const mockEmbed = jest.fn();
const mockUpsert = jest.fn();
const mockMark = jest.fn();
let configured = true;

jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a) }));
jest.mock("../embedder", () => ({
  embedBatch: (...a: unknown[]) => mockEmbed(...a),
  isEmbeddingConfigured: () => configured,
  embeddingBackend: () => (configured ? "azure" : "none"),
}));
jest.mock("../qdrant", () => ({ upsertBrainPoints: (...a: unknown[]) => mockUpsert(...a) }));
jest.mock("../repo", () => ({ markChunksEmbedded: (...a: unknown[]) => mockMark(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

import { backfillEmbeddings } from "../backfill";

const chunk = (id: string) => ({
  id,
  document_id: "d1",
  chunk_idx: 0,
  content: `content ${id}`,
  filename: "f.pdf",
  kind: "doc",
  uploaded_by: "u1",
  created_at: "2026-01-01",
});

/** count query, then batches, then the final count. */
function plan(pending: number, batches: ReturnType<typeof chunk>[][]) {
  mockQuery.mockReset();
  mockQuery.mockImplementation((sql: string) => {
    if (String(sql).includes("count(*)")) return { rows: [{ n: pending }] };
    const next = batches.shift() ?? [];
    return { rows: next };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  configured = true;
  mockEmbed.mockReset();
  mockUpsert.mockReset().mockResolvedValue(undefined);
  mockMark.mockReset().mockResolvedValue(undefined);
});

describe("when embeddings are not configured", () => {
  it("refuses instead of walking the backlog and embedding nothing", async () => {
    configured = false;
    await expect(backfillEmbeddings()).rejects.toThrow(/not configured/i);
  });

  it("names the variables somebody has to set", async () => {
    configured = false;
    await expect(backfillEmbeddings()).rejects.toThrow(/AZURE_OPENAI_EMBEDDING_DEPLOYMENT/);
  });
});

describe("embedding the backlog", () => {
  it("stores the vector BEFORE marking the row, so a crash loses nothing", async () => {
    const order: string[] = [];
    mockUpsert.mockImplementation(async () => void order.push("upsert"));
    mockMark.mockImplementation(async () => void order.push("mark"));
    plan(2, [[chunk("a"), chunk("b")], []]);
    mockEmbed.mockResolvedValue({ vectors: [[1], [2]], tokensUsed: 0, model: "m" });
    await backfillEmbeddings({ batchSize: 2 });
    expect(order).toEqual(["upsert", "mark"]);
  });

  it("refuses a batch whose vector count does not match its chunks", async () => {
    /* Mismatched lists would attach the wrong meaning to the right document,
       which is worse than leaving it unembedded. */
    plan(2, [[chunk("a"), chunk("b")], []]);
    mockEmbed.mockResolvedValue({ vectors: [[1]], tokensUsed: 0, model: "m" });
    const r = await backfillEmbeddings({ batchSize: 2 });
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(r.embedded).toBe(0);
    expect(r.failedBatches).toBe(1);
  });

  it("stops on a failing batch rather than grinding through a broken provider", async () => {
    plan(4, [[chunk("a")], [chunk("b")], []]);
    mockEmbed.mockRejectedValue(new Error("azure said no"));
    const r = await backfillEmbeddings({ batchSize: 1 });
    expect(r.failedBatches).toBe(1);
    expect(mockEmbed).toHaveBeenCalledTimes(1);
  });

  it("writes nothing on a dry run", async () => {
    plan(3, [[chunk("a"), chunk("b"), chunk("c")]]);
    const r = await backfillEmbeddings({ dryRun: true });
    expect(mockEmbed).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockMark).not.toHaveBeenCalled();
    expect(r.embedded).toBe(3);
    expect(r.dryRun).toBe(true);
  });

  it("is a no-op when there is nothing left, so it is safe to re-run", async () => {
    plan(0, [[]]);
    const r = await backfillEmbeddings();
    expect(r.embedded).toBe(0);
    expect(mockEmbed).not.toHaveBeenCalled();
  });
});
