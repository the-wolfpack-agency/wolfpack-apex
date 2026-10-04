/**
 * Memory provenance store: pure normalizer + the never-throwing record/load over a
 * mocked db. Real-schema landing + ON CONFLICT dedup is in the .db.test.ts.
 */
const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a), safeQuery: (...a: unknown[]) => mockSafeQuery(...a) }));

import { normalizeProvenance, recordMemoryProvenance, loadProvenanceByApproval, MAX_PROVENANCE } from "@/lib/ai-code/factory-provenance";

beforeEach(() => jest.clearAllMocks());

describe("normalizeProvenance", () => {
  it("drops blanks/bad kinds, dedupes by (kind,key), caps", () => {
    const out = normalizeProvenance([
      { kind: "reuse", key: "a.ts" },
      { kind: "reuse", key: "a.ts" }, // dupe
      { kind: "failure", key: "a.ts" }, // same key, different kind -> kept
      { kind: "reuse", key: "" }, // blank
      { kind: "bogus" as never, key: "x" }, // bad kind
    ]);
    expect(out).toEqual([{ kind: "reuse", key: "a.ts" }, { kind: "failure", key: "a.ts" }]);
  });
  it("caps at MAX_PROVENANCE", () => {
    const many = Array.from({ length: MAX_PROVENANCE + 10 }, (_, i) => ({ kind: "reuse" as const, key: `p${i}` }));
    expect(normalizeProvenance(many).length).toBe(MAX_PROVENANCE);
  });
});

describe("recordMemoryProvenance", () => {
  it("no-op without an approvalId or entries (no query)", async () => {
    expect((await recordMemoryProvenance("w1", "", "o/r", [{ kind: "reuse", key: "a" }])).written).toBe(0);
    expect((await recordMemoryProvenance("w1", "appr1", "o/r", [])).written).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });
  it("upserts ON CONFLICT DO NOTHING, approval+workspace scoped", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const r = await recordMemoryProvenance("w1", "appr1", "o/r", [{ kind: "reuse", key: "src/a.ts" }, { kind: "failure", key: "sig1" }]);
    expect(r.written).toBe(2);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO instinct_factory_memory_provenance/);
    expect(sql).toMatch(/ON CONFLICT \(workspace_id, approval_id, kind, mem_key\) DO NOTHING/);
    expect(params.slice(0, 3)).toEqual(["w1", "appr1", "o/r"]);
  });
  it("never throws on a db error (best-effort learning telemetry)", async () => {
    mockQuery.mockRejectedValue(new Error("db down"));
    await expect(recordMemoryProvenance("w1", "appr1", "o/r", [{ kind: "reuse", key: "a" }])).resolves.toEqual({ written: 0 });
  });
});

describe("loadProvenanceByApproval", () => {
  it("returns scoped entries, filtering unknown kinds; [] without approvalId", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [{ kind: "reuse", mem_key: "a" }, { kind: "failure", mem_key: "s" }, { kind: "junk", mem_key: "x" }] });
    expect(await loadProvenanceByApproval("w1", "appr1")).toEqual([{ kind: "reuse", key: "a" }, { kind: "failure", key: "s" }]);
    expect(mockSafeQuery.mock.calls[0][1]).toEqual(["w1", "appr1"]);
    expect(await loadProvenanceByApproval("w1", "")).toEqual([]);
  });
});
