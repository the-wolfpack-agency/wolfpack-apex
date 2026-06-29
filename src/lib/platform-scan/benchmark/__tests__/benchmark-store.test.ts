/**
 * benchmark-store round-trip (db mocked).
 *
 * recordBenchmarkRun writes one row with the headline metrics broken out and the
 * full report + signals as JSONB; listRecentBenchmarkRuns reads recent rows back
 * shaped for the dashboard. Both degrade gracefully (writeQuery throw -> {id:null}
 * and never re-throws; safeQuery -> [] with no DB) so a store hiccup never loses
 * the scored run nor 500s the dashboard.
 */
const mockWriteQuery = jest.fn();
const mockSafeQuery = jest.fn();

jest.mock("@/lib/db", () => ({
  writeQuery: (...a: unknown[]) => mockWriteQuery(...a),
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));

import {
  recordBenchmarkRun,
  listRecentBenchmarkRuns,
} from "@/lib/platform-scan/benchmark/benchmark-store";
import type { BenchmarkReport, LearningSignal } from "@/lib/platform-scan/benchmark/scorer";

const REPORT: BenchmarkReport = {
  targets: 3,
  perTarget: [
    { name: "a", matched: ["x:y"], missed: [], extra: [], recall: 1, labeled: true },
  ],
  recall: 0.5,
  precision: 0.8,
  coverageClasses: ["x:y", "p:q"],
  erroredCount: 1,
  labeledTargets: 2,
};

const SIGNALS: LearningSignal[] = [
  { kind: "coverage_gap", findingClass: "z:missed", detail: "build a detector" },
];

beforeEach(() => {
  jest.clearAllMocks();
  // The insert now uses RETURNING id + expectRows:1, so a successful write returns
  // exactly one row. (A 0-row write is the discarded-write case - tested below.)
  mockWriteQuery.mockResolvedValue({ rows: [{ id: "bench_db" }] });
  mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
});

describe("recordBenchmarkRun", () => {
  test("inserts one row with metrics broken out + report/signals as JSON, returns a bench_ id", async () => {
    const { id } = await recordBenchmarkRun(REPORT, SIGNALS);
    expect(id).toMatch(/^bench_/);
    expect(mockWriteQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockWriteQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO instinct_benchmark_runs/i);
    // id, targets, labeled_targets, recall, precision, coverage_classes(len), errored, report, signals
    expect(params[0]).toBe(id);
    expect(params[1]).toBe(3); // targets
    expect(params[2]).toBe(2); // labeled_targets
    expect(params[3]).toBe(0.5); // recall (in-range -> unchanged by clampRatio)
    expect(params[4]).toBe(0.8); // precision
    expect(params[5]).toBe(2); // coverage_classes -> coverageClasses.length
    expect(params[6]).toBe(1); // errored
    expect(JSON.parse(params[7] as string)).toEqual(REPORT);
    expect(JSON.parse(params[8] as string)).toEqual(SIGNALS);
    // FALSE-SUCCESS FIX (#1): the write asserts exactly one row landed.
    expect(sql).toMatch(/RETURNING id/i);
    expect(mockWriteQuery.mock.calls[0][2]).toEqual({ expectRows: 1 });
  });

  test("FALSE-SUCCESS: a 0-row discarded write does NOT return a fake id (degrades to { id: null })", async () => {
    // With expectRows:1 the strict writeQuery throws on a 0-row (RLS-discarded)
    // write; recordBenchmarkRun catches and returns { id: null } instead of the
    // old behavior of reporting a bench_ id that was never persisted. The scorer
    // already emitted analytics, so the run is not lost - only the trend row, and
    // the caller degrades gracefully.
    mockWriteQuery.mockRejectedValue(
      Object.assign(new Error("row-count mismatch: expected 1, got 0"), { code: "unexpected_row_count" }),
    );
    await expect(recordBenchmarkRun(REPORT, SIGNALS)).resolves.toEqual({ id: null });
  });

  test("LOSSY-METRIC FIX (#5): out-of-range / non-finite ratios are clamped to [0,1] before write", async () => {
    await recordBenchmarkRun({ ...REPORT, recall: 1.4, precision: Number.NaN }, SIGNALS);
    const params = mockWriteQuery.mock.calls[0][1] as unknown[];
    expect(params[3]).toBe(1); // recall 1.4 clamped to 1
    expect(params[4]).toBe(0); // precision NaN -> 0 (never a NaN ratio in the column)
  });

  test("degrades gracefully: a write throw returns { id: null } and does not re-throw", async () => {
    mockWriteQuery.mockRejectedValue(new Error("db down"));
    await expect(recordBenchmarkRun(REPORT, SIGNALS)).resolves.toEqual({ id: null });
  });
});

describe("listRecentBenchmarkRuns", () => {
  test("maps db rows to the dashboard shape", async () => {
    const runAt = new Date("2026-06-19T00:00:00.000Z");
    mockSafeQuery.mockResolvedValue({
      rows: [
        {
          id: "bench_1",
          run_at: runAt,
          targets: 5,
          labeled_targets: 2,
          recall: "0.75",
          precision: "0.9",
          coverage_classes: 7,
          errored: 1,
          report: REPORT,
          signals: SIGNALS,
        },
      ],
      fromCache: false,
    });
    const runs = await listRecentBenchmarkRuns(10);
    expect(runs).toEqual([
      {
        id: "bench_1",
        runAt: runAt.toISOString(),
        targets: 5,
        labeledTargets: 2,
        recall: 0.75,
        precision: 0.9,
        coverageClasses: 7,
        errored: 1,
        report: REPORT,
        signals: SIGNALS,
      },
    ]);
  });

  test("clamps the limit into [1, 100]", async () => {
    await listRecentBenchmarkRuns(9999);
    expect(mockSafeQuery.mock.calls[0][1]).toEqual([100]);
    await listRecentBenchmarkRuns(0);
    expect(mockSafeQuery.mock.calls[1][1]).toEqual([1]);
    await listRecentBenchmarkRuns();
    expect(mockSafeQuery.mock.calls[2][1]).toEqual([20]); // default
  });

  test("degrades to [] with no DB (safeQuery returns empty)", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: true });
    await expect(listRecentBenchmarkRuns()).resolves.toEqual([]);
  });
});
