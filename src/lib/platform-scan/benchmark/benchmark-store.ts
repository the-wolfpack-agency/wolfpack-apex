/**
 * Benchmark-run persistence — the durable side of the active-learning loop.
 *
 * The scorer (scorer.ts) is PURE: it computes a BenchmarkReport + mines
 * LearningSignal[] and emits analytics, but persists nothing. This store closes
 * that gap: recordBenchmarkRun writes ONE row per scoring run (headline metrics
 * broken out for the trend, full report + signals as JSONB for drill-down), and
 * listRecentBenchmarkRuns reads the recent runs back for the dashboard
 * (recall/coverage trend + the live signal backlog).
 *
 * No data lost: every benchmark run and every mined signal becomes durable here,
 * complementing the analytics events the scorer already fires. Mirrors the
 * platform-scan store idiom (one row per durable fact; writeQuery for the write,
 * safeQuery for the read so a missing DB degrades to [] instead of throwing).
 */

import { randomUUID } from "crypto";
import { safeQuery, writeQuery } from "@/lib/db";
import type { BenchmarkReport, LearningSignal } from "./scorer";

/** A persisted benchmark run, shaped for the dashboard trend + backlog. */
export interface BenchmarkRunRow {
  id: string;
  runAt: string;
  targets: number;
  labeledTargets: number;
  recall: number;
  precision: number;
  coverageClasses: number;
  errored: number;
  report: BenchmarkReport;
  signals: LearningSignal[];
}

type DbRow = Record<string, unknown>;

function toRunRow(r: DbRow): BenchmarkRunRow {
  return {
    id: String(r.id),
    runAt: r.run_at instanceof Date ? r.run_at.toISOString() : String(r.run_at),
    targets: Number(r.targets) || 0,
    labeledTargets: Number(r.labeled_targets) || 0,
    recall: Number(r.recall) || 0,
    precision: Number(r.precision) || 0,
    coverageClasses: Number(r.coverage_classes) || 0,
    errored: Number(r.errored) || 0,
    report: (r.report ?? {}) as BenchmarkReport,
    signals: (r.signals ?? []) as LearningSignal[],
  };
}

/**
 * Persist one scored benchmark run. Breaks the headline metrics out into
 * columns (so the trend chart can aggregate without parsing JSON) and stores the
 * full report + mined signals as JSONB for drill-down / the gap backlog.
 *
 * Degrades gracefully: a DB error (or shadow mode) is caught and the function
 * returns { id: null } rather than throwing, so a transient store hiccup never
 * loses the run that the scorer already emitted to analytics — the route stays
 * 200 and the in-memory report is still returned to the caller.
 */
export async function recordBenchmarkRun(
  report: BenchmarkReport,
  signals: LearningSignal[],
): Promise<{ id: string | null }> {
  const id = `bench_${randomUUID()}`;
  try {
    await writeQuery(
      `INSERT INTO instinct_benchmark_runs
         (id, targets, labeled_targets, recall, precision, coverage_classes, errored, report, signals)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)`,
      [
        id,
        report.targets,
        report.labeledTargets,
        report.recall,
        report.precision,
        report.coverageClasses.length,
        report.erroredCount,
        JSON.stringify(report),
        JSON.stringify(signals),
      ],
    );
    return { id };
  } catch (err) {
    // Best effort: the scorer already emitted platform.benchmark_run +
    // platform.learning_signal_detected, so the learning loop has the data even
    // if persistence failed. Never throw from the persistence seam.
    console.warn("[benchmark-store] recordBenchmarkRun failed:", (err as Error).message);
    return { id: null };
  }
}

/**
 * Recent benchmark runs, newest first, for the dashboard. Default limit 20,
 * capped at 100. Degrades to [] with no DB (safeQuery) so the dashboard renders
 * an explicit empty state rather than 500ing.
 */
export async function listRecentBenchmarkRuns(limit?: number): Promise<BenchmarkRunRow[]> {
  const lim = Math.min(Math.max(limit ?? 20, 1), 100);
  const { rows } = await safeQuery<DbRow>(
    `SELECT id, run_at, targets, labeled_targets, recall, precision,
            coverage_classes, errored, report, signals
       FROM instinct_benchmark_runs
      ORDER BY run_at DESC
      LIMIT $1`,
    [lim],
  );
  return rows.map(toRunRow);
}
