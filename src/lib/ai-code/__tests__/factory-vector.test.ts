/**
 * Qdrant factory-vector client: pure id hashing + the REST ops over an injected
 * fetch. Proves scoping filter shape, graceful degrade (never throws; falsy/[]
 * on failure), and idempotent ensureCollection.
 */
import {
  pointId,
  ensureCollection,
  upsertPoints,
  searchPoints,
  rerankByConfidence,
  qdrantConfigFromEnv,
  type QdrantConfig,
} from "@/lib/ai-code/factory-vector";

const ok = (body: unknown = {}) => ({ ok: true, json: async () => body }) as unknown as Response;
const notOk = (status = 500) => ({ ok: false, status, json: async () => ({}) }) as unknown as Response;
const cfg = (fetchImpl: typeof fetch): QdrantConfig => ({ url: "http://q", apiKey: "k", fetchImpl });

describe("pointId", () => {
  it("is deterministic + collision-stable per key", () => {
    expect(pointId("w|o/r|a.ts")).toBe(pointId("w|o/r|a.ts"));
    expect(pointId("w|o/r|a.ts")).not.toBe(pointId("w|o/r|b.ts"));
    expect(Number.isSafeInteger(pointId("x"))).toBe(true);
  });
});

describe("qdrantConfigFromEnv", () => {
  const prev = process.env.QDRANT_URL;
  afterEach(() => { if (prev === undefined) delete process.env.QDRANT_URL; else process.env.QDRANT_URL = prev; });
  it("null when unconfigured", () => { delete process.env.QDRANT_URL; expect(qdrantConfigFromEnv()).toBeNull(); });
  it("config when QDRANT_URL set", () => { process.env.QDRANT_URL = "http://q"; expect(qdrantConfigFromEnv()?.url).toBe("http://q"); });
});

describe("ensureCollection", () => {
  it("returns true without creating when the collection already exists", async () => {
    const f = jest.fn().mockResolvedValue(ok());
    expect(await ensureCollection(cfg(f as unknown as typeof fetch), "c", 8)).toBe(true);
    expect(f).toHaveBeenCalledTimes(1); // existence check only, no PUT create
  });
  it("creates with the given dim + cosine when absent", async () => {
    const f = jest.fn().mockResolvedValueOnce(notOk(404)).mockResolvedValueOnce(ok());
    expect(await ensureCollection(cfg(f as unknown as typeof fetch), "c", 1536)).toBe(true);
    const body = JSON.parse((f.mock.calls[1][1] as { body: string }).body);
    expect(body.vectors).toEqual({ size: 1536, distance: "Cosine" });
  });
  it("false on transport error (never throws)", async () => {
    const f = jest.fn().mockRejectedValue(new Error("down"));
    expect(await ensureCollection(cfg(f as unknown as typeof fetch), "c", 8)).toBe(false);
  });
});

describe("upsertPoints", () => {
  it("true on empty input without calling fetch", async () => {
    const f = jest.fn();
    expect(await upsertPoints(cfg(f as unknown as typeof fetch), "c", [])).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });
  it("false on a non-ok response", async () => {
    const f = jest.fn().mockResolvedValue(notOk());
    expect(await upsertPoints(cfg(f as unknown as typeof fetch), "c", [{ id: 1, vector: [1], payload: {} }])).toBe(false);
  });
});

describe("searchPoints", () => {
  it("sends an exact-match must-filter (tenant scoping) and maps hits", async () => {
    const f = jest.fn().mockResolvedValue(ok({ result: [{ id: 1, score: 0.9, payload: { path: "a.ts" } }] }));
    const hits = await searchPoints(cfg(f as unknown as typeof fetch), "c", [0.1, 0.2], { workspace_id: "w1", repo: "o/r" }, 5);
    expect(hits).toEqual([{ id: 1, score: 0.9, payload: { path: "a.ts" } }]);
    const body = JSON.parse((f.mock.calls[0][1] as { body: string }).body);
    expect(body.filter.must).toEqual([
      { key: "workspace_id", match: { value: "w1" } },
      { key: "repo", match: { value: "o/r" } },
    ]);
  });
  it("[] on empty vector, non-ok, or transport error", async () => {
    expect(await searchPoints(cfg((() => {}) as unknown as typeof fetch), "c", [], {}, 5)).toEqual([]);
    expect(await searchPoints(cfg(jest.fn().mockResolvedValue(notOk()) as unknown as typeof fetch), "c", [1], {}, 5)).toEqual([]);
    expect(await searchPoints(cfg(jest.fn().mockRejectedValue(new Error("x")) as unknown as typeof fetch), "c", [1], {}, 5)).toEqual([]);
  });
});

describe("rerankByConfidence", () => {
  const key = (h: { path: string }) => h.path;
  it("a lower-similarity but high-confidence hit can outrank a higher-similarity doubtful one", () => {
    const hits = [{ path: "a", score: 0.9 }, { path: "b", score: 0.6 }];
    // a is doubtful (0.3), b is proven (1.5): weighted 0.27 vs 0.9 -> b first.
    const out = rerankByConfidence(hits, key, new Map([["a", 0.3], ["b", 1.5]]));
    expect(out.map((h) => h.path)).toEqual(["b", "a"]);
  });
  it("missing/1.0 confidence leaves order unchanged (stable, zero behavior change)", () => {
    const hits = [{ path: "a", score: 0.9 }, { path: "b", score: 0.9 }, { path: "c", score: 0.8 }];
    expect(rerankByConfidence(hits, key, new Map()).map((h) => h.path)).toEqual(["a", "b", "c"]);
    expect(rerankByConfidence(hits, key, new Map([["a", 1], ["b", 1], ["c", 1]])).map((h) => h.path)).toEqual(["a", "b", "c"]);
  });
});
