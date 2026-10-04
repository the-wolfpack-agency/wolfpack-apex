/**
 * Factory brain summary: composes the per-signal loaders into one headline view,
 * each piece guarded so a cold/absent signal degrades to null (honest), never
 * breaks the summary.
 */
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({ safeQuery: (...a: unknown[]) => mockSafeQuery(...a) }));
jest.mock("@/lib/ai-code/loop-efficacy", () => ({ loadLoopEfficacy: jest.fn() }));
jest.mock("@/lib/ai-code/gate-precision", () => ({ loadGatePrecision: jest.fn() }));
jest.mock("@/lib/ai-code/task-type", () => ({ loadTaskTypeGrades: jest.fn() }));
jest.mock("@/lib/ai-code/factory-repair-recipes", () => ({ loadRepairEfficacy: jest.fn() }));
jest.mock("@/lib/ai-code/factory-reuse-store", () => ({ countReuseCorpus: jest.fn() }));
jest.mock("@/lib/ai-code/factory-failure-store", () => ({ countFailures: jest.fn() }));

import { loadBrainSummary } from "@/lib/ai-code/factory-brain-summary";
import { loadLoopEfficacy } from "@/lib/ai-code/loop-efficacy";
import { loadGatePrecision } from "@/lib/ai-code/gate-precision";
import { loadTaskTypeGrades } from "@/lib/ai-code/task-type";
import { loadRepairEfficacy } from "@/lib/ai-code/factory-repair-recipes";
import { countReuseCorpus } from "@/lib/ai-code/factory-reuse-store";
import { countFailures } from "@/lib/ai-code/factory-failure-store";

beforeEach(() => jest.clearAllMocks());

describe("loadBrainSummary", () => {
  it("composes headline signals + computes overall precision/repair/correction rates", async () => {
    (countReuseCorpus as jest.Mock).mockResolvedValue(42);
    (countFailures as jest.Mock).mockResolvedValue(7);
    (loadLoopEfficacy as jest.Mock).mockResolvedValue({ firstPassReadyRate: 0.8, acceptanceRate: 0.6, readyTrend: "up", runs: 12 });
    (loadGatePrecision as jest.Mock).mockResolvedValue({ classes: [{ wrong: 1, reviewed: 4 }, { wrong: 1, reviewed: 6 }] });
    (loadRepairEfficacy as jest.Mock).mockResolvedValue({ byCategory: [{ resolved: 3, runs: 4 }, { resolved: 1, runs: 6 }] });
    (loadTaskTypeGrades as jest.Mock).mockResolvedValue({ byModelTask: [{}, {}, {}] });
    // exemplars count, then corrections aggregate
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [{ n: 5 }] })
      .mockResolvedValueOnce({ rows: [{ total: 10, edited: 3 }] });

    const s = await loadBrainSummary("w1", 30);
    expect(s.memory).toEqual({ reuse: 42, failures: 7, exemplars: 5 });
    expect(s.improving).toEqual({ firstPassReadyRate: 0.8, acceptanceRate: 0.6, trend: "up", runs: 12 });
    expect(s.precision).toEqual({ wrongRate: 2 / 10, reviewed: 10 });
    expect(s.repair).toEqual({ resolveRate: 4 / 10, runs: 10 });
    expect(s.grades).toEqual({ cells: 3 });
    expect(s.corrections).toEqual({ editRate: 0.3, merged: 10 });
  });

  it("degrades to null tiles on a cold start (no data), never throws", async () => {
    (countReuseCorpus as jest.Mock).mockResolvedValue(0);
    (countFailures as jest.Mock).mockResolvedValue(0);
    (loadLoopEfficacy as jest.Mock).mockResolvedValue({ firstPassReadyRate: null, acceptanceRate: null, readyTrend: "n/a", runs: 0 });
    (loadGatePrecision as jest.Mock).mockResolvedValue({ classes: [] });
    (loadRepairEfficacy as jest.Mock).mockResolvedValue({ byCategory: [] });
    (loadTaskTypeGrades as jest.Mock).mockResolvedValue({ byModelTask: [] });
    mockSafeQuery.mockResolvedValue({ rows: [{ n: 0 }] }); // exemplars; corrections -> {} -> defaults

    const s = await loadBrainSummary("w1", 30);
    expect(s.precision.wrongRate).toBeNull();
    expect(s.repair.resolveRate).toBeNull();
    expect(s.corrections.editRate).toBeNull();
    expect(s.improving.firstPassReadyRate).toBeNull();
  });

  it("survives a loader that throws (that tile falls back)", async () => {
    (countReuseCorpus as jest.Mock).mockRejectedValue(new Error("db"));
    (countFailures as jest.Mock).mockResolvedValue(9);
    (loadLoopEfficacy as jest.Mock).mockRejectedValue(new Error("db"));
    (loadGatePrecision as jest.Mock).mockResolvedValue({ classes: [] });
    (loadRepairEfficacy as jest.Mock).mockResolvedValue({ byCategory: [] });
    (loadTaskTypeGrades as jest.Mock).mockResolvedValue({ byModelTask: [] });
    mockSafeQuery.mockResolvedValue({ rows: [] });

    const s = await loadBrainSummary("w1", 30);
    expect(s.memory.reuse).toBe(0);       // threw -> fallback 0
    expect(s.memory.failures).toBe(9);
    expect(s.improving.runs).toBe(0);     // threw -> fallback null -> runs 0
  });
});
