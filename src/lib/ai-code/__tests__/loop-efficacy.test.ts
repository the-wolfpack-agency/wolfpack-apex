/**
 * Loop efficacy: the pure summarizer (rates + trend) and the never-throwing loader
 * over a mocked db (3 aggregate queries, workspace-scoped).
 */
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({ safeQuery: (...a: unknown[]) => mockSafeQuery(...a) }));

import { summarizeLoopEfficacy, trendOf, loadLoopEfficacy, type LoopEfficacyCounts } from "@/lib/ai-code/loop-efficacy";

const base: LoopEfficacyCounts = {
  runs: 0, ready: 0, dupEscalated: 0, semanticRuns: 0, merged: 0, closed: 0,
  findingsTotal: 0, findingClassesDistinct: 0, recentRuns: 0, recentReady: 0, priorRuns: 0, priorReady: 0,
};

beforeEach(() => jest.clearAllMocks());

describe("trendOf", () => {
  it("up when recent beats prior beyond eps, down when worse, flat within eps, n/a on null", () => {
    expect(trendOf(0.8, 0.5)).toBe("up");
    expect(trendOf(0.5, 0.8)).toBe("down");
    expect(trendOf(0.52, 0.5)).toBe("flat");
    expect(trendOf(null, 0.5)).toBe("n/a");
    expect(trendOf(0.5, null)).toBe("n/a");
  });
});

describe("summarizeLoopEfficacy", () => {
  it("computes every rate + a null rate when the denominator is 0", () => {
    const e = summarizeLoopEfficacy({
      ...base, runs: 10, ready: 7, dupEscalated: 2, semanticRuns: 6,
      merged: 3, closed: 1, findingsTotal: 8, findingClassesDistinct: 5,
      recentRuns: 5, recentReady: 4, priorRuns: 5, priorReady: 2,
    }, 30);
    expect(e.firstPassReadyRate).toBeCloseTo(0.7, 5);
    expect(e.acceptanceRate).toBeCloseTo(3 / 4, 5);
    expect(e.duplicationRate).toBeCloseTo(0.2, 5);
    expect(e.reuseSemanticRate).toBeCloseTo(0.6, 5);
    expect(e.repeatFindingRate).toBeCloseTo((8 - 5) / 8, 5); // 3 repeats of 8
    expect(e.readyTrend).toBe("up"); // 0.8 recent vs 0.4 prior
  });
  it("null rates + n/a trend on an empty window (never divides by zero)", () => {
    const e = summarizeLoopEfficacy(base, 30);
    expect(e.firstPassReadyRate).toBeNull();
    expect(e.acceptanceRate).toBeNull();
    expect(e.repeatFindingRate).toBeNull();
    expect(e.readyTrend).toBe("n/a");
  });
});

describe("loadLoopEfficacy", () => {
  it("runs 3 workspace-scoped aggregates and summarizes them", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [{ runs: 4, ready: 3, dup: 1, semantic: 2, recent_runs: 2, recent_ready: 2, prior_runs: 2, prior_ready: 1 }] })
      .mockResolvedValueOnce({ rows: [{ merged: 2, closed: 1 }] })
      .mockResolvedValueOnce({ rows: [{ total: 6, distinct_classes: 4 }] });
    const e = await loadLoopEfficacy("w1", 30);
    expect(mockSafeQuery.mock.calls[0][1]).toEqual(["30", "w1"]); // scoped
    expect(mockSafeQuery.mock.calls[2][1]).toEqual(["30", "w1"]);
    expect(e.runs).toBe(4);
    expect(e.firstPassReadyRate).toBeCloseTo(0.75, 5);
    expect(e.acceptanceRate).toBeCloseTo(2 / 3, 5);
    expect(e.repeatFindingRate).toBeCloseTo(2 / 6, 5);
    expect(e.readyTrend).toBe("up"); // recent 1.0 vs prior 0.5
  });
  it("clamps days to >= 2 (the trend needs two halves)", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [{}] });
    const e = await loadLoopEfficacy("w1", 1);
    expect(e.windowDays).toBe(2);
    expect(mockSafeQuery.mock.calls[0][1]).toEqual(["2", "w1"]);
  });
});
