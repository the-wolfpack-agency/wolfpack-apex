/**
 * #8 repair recipes: pure summarizer + the never-throwing record/load over a
 * mocked db. Real-schema landing is in the .db.test.ts.
 */
const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a), safeQuery: (...a: unknown[]) => mockSafeQuery(...a) }));

import { recordRepairOutcome, loadRepairEfficacy, summarizeRepairEfficacy } from "@/lib/ai-code/factory-repair-recipes";

beforeEach(() => jest.clearAllMocks());

describe("summarizeRepairEfficacy", () => {
  it("computes resolve rate per category, most runs first; drops zero-run", () => {
    const e = summarizeRepairEfficacy(
      [
        { blocked_by: "security", runs: 10, resolved: 7 },
        { blocked_by: "invariant", runs: 4, resolved: 1 },
        { blocked_by: "deep-scan", runs: 0, resolved: 0 },
      ],
      30,
    );
    expect(e.windowDays).toBe(30);
    expect(e.byCategory).toHaveLength(2);
    expect(e.byCategory[0]).toEqual({ category: "security", runs: 10, resolved: 7, resolveRate: 0.7 });
    expect(e.byCategory[1].resolveRate).toBeCloseTo(0.25, 5);
  });
});

describe("recordRepairOutcome", () => {
  it("no-op for a non-block category (nothing to learn), no query", async () => {
    expect((await recordRepairOutcome({ workspaceId: "w1", repo: "o/r", blockedBy: null, attempts: 1, resolved: true })).written).toBe(0);
    expect((await recordRepairOutcome({ workspaceId: "w1", repo: "o/r", blockedBy: "bogus", attempts: 1, resolved: true })).written).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });
  it("inserts a known category, clamping attempts", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    const r = await recordRepairOutcome({ workspaceId: "w1", repo: "o/r", blockedBy: "security", attempts: -5, resolved: true });
    expect(r.written).toBe(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO instinct_factory_repair_recipes/);
    expect(params).toEqual(["w1", "o/r", "security", 0, true]);
  });
  it("never throws on a db error", async () => {
    mockQuery.mockRejectedValue(new Error("db"));
    await expect(recordRepairOutcome({ workspaceId: "w1", repo: "o/r", blockedBy: "invariant", attempts: 2, resolved: false })).resolves.toEqual({ written: 0 });
  });
});

describe("loadRepairEfficacy", () => {
  it("groups by category, workspace + window scoped", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [{ blocked_by: "deep-scan", runs: 3, resolved: 2 }] });
    const e = await loadRepairEfficacy("w1", 14);
    expect(mockSafeQuery.mock.calls[0][1]).toEqual(["w1", "14"]);
    expect(e.byCategory[0]).toEqual({ category: "deep-scan", runs: 3, resolved: 2, resolveRate: 2 / 3 });
  });
  it("[] shape on empty", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    expect((await loadRepairEfficacy("w1", 30)).byCategory).toEqual([]);
  });
});
