/**
 * Competitor-benchmark-run persistence - the durable side of the head-to-head.
 *
 * competitive.ts is PURE: it normalizes + scores a rival and builds a
 * CompetitiveReport but persists nothing. This store closes that gap:
 * recordCompetitorRun writes ONE row per (tool, target) scoring run (headline
 * recall/precision/findings broken out for the comparison bars, full report as
 * JSONB for drill-down), and listRecentCompetitorRuns reads them back for the
 * dashboard's "Versus the competition" section.
 *
 * Mirrors benchmark-store.ts exactly: writeQuery for the write (best effort, never
 * throws from the persistence seam), safeQuery for the read (a missing DB degrades
 * to [] so the dashboard renders an explicit empty state instead of 500ing). No
 * data lost: every competitor run becomes durable here, complementing the
 * analytics events competitive.ts already fires.
 */

import { randomUUID } from "crypto";
import { safeQuery, writeQuery } from "@/lib/db";
import type { CompetitiveReport, CompetitorTool, OurTargetScore } from "./competitive";
import { precisionOf } from "./competitive";
import type { TargetScore } from "./scorer";

/** A persisted competitor run, shaped for the dashboard comparison.
 *  recall/precision are `null` (NOT APPLICABLE) on an unlabeled target - the
 *  dashboard renders "n/a", never a fabricated 0 or 100%. */
export interface CompetitorRunRow {
  id: string;
  runAt: string;
  tool: CompetitorTool;
  target: string;
  recall: number | null;
  precision: number | null;
  findings: number;
  report: CompetitiveReport;
}

type DbRow = Record<string, unknown>;

/** A numeric column that may legitimately be SQL NULL (recall/precision when not
 *  applicable). Preserves null instead of coercing it to 0 - a 0 recall is a real,
 *  bad score; null means "not measurable", and conflating them is a lie. */
function nullableNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toRunRow(r: DbRow): CompetitorRunRow {
  return {
    id: String(r.id),
    runAt: r.run_at instanceof Date ? r.run_at.toISOString() : String(r.run_at),
    tool: String(r.tool) as CompetitorTool,
    target: String(r.target),
    recall: nullableNumber(r.recall),
    precision: nullableNumber(r.precision),
    findings: Number(r.findings) || 0,
    report: (r.report ?? {}) as CompetitiveReport,
  };
}

/**
 * Persist one competitor scoring run. Breaks the headline metrics out into columns
 * (so the comparison bars aggregate without parsing JSON) and stores the full
 * CompetitiveReport as JSONB for drill-down / the rival-only-gap backlog.
 *
 * Degrades gracefully: a DB error (or shadow mode) is caught and the function
 * returns { id: null } rather than throwing, so a transient store hiccup never
 * loses the run that competitive.ts already emitted to analytics - the route stays
 * 200 and the in-memory report is still returned to the caller.
 */
export async function recordCompetitorRun(args: {
  tool: CompetitorTool;
  target: string;
  recall: number | null;
  precision: number | null;
  findings: number;
  report: CompetitiveReport;
}): Promise<{ id: string | null }> {
  const id = `comp_${randomUUID()}`;
  try {
    await writeQuery(
      `INSERT INTO instinct_competitor_benchmark_runs
         (id, tool, target, recall, precision, findings, report)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        id,
        args.tool,
        args.target,
        args.recall,
        args.precision,
        args.findings,
        JSON.stringify(args.report),
      ],
    );
    return { id };
  } catch (err) {
    // Best effort: competitive.ts already emitted platform.competitor_benchmark_run
    // (+ gap/parity events), so the learning loop has the data even if persistence
    // failed. Never throw from the persistence seam.
    console.warn(
      "[competitive-store] recordCompetitorRun failed:",
      (err as Error).message,
    );
    return { id: null };
  }
}

/**
 * Recent competitor runs, newest first, for the dashboard. Default limit 50, capped
 * at 200 (a few tools x a few targets per sweep). Degrades to [] with no DB
 * (safeQuery) so the dashboard renders an explicit empty state rather than 500ing.
 */
export async function listRecentCompetitorRuns(limit?: number): Promise<CompetitorRunRow[]> {
  const lim = Math.min(Math.max(limit ?? 50, 1), 200);
  const { rows } = await safeQuery<DbRow>(
    `SELECT id, run_at, tool, target, recall, precision, findings, report
       FROM instinct_competitor_benchmark_runs
      ORDER BY run_at DESC
      LIMIT $1`,
    [lim],
  );
  return rows.map(toRunRow);
}

/**
 * The LATEST competitor run for EACH (tool, target) pair, computed in SQL with
 * DISTINCT ON (fix #7). The dashboard's "Versus the competition" comparison wants
 * exactly one row per pair - the newest. The route previously read a truncated
 * 200-row window and de-duped client-side, which could DROP the newest run for a
 * pair when older runs filled the window first. Selecting in SQL is correct
 * regardless of how many historical runs exist.
 *
 * DISTINCT ON (tool, target) keeps the first row per pair under the ORDER BY, so
 * ordering by (tool, target, run_at DESC) yields the newest per pair. We then
 * re-sort newest-first overall for stable display. Degrades to [] with no DB.
 */
export async function listLatestCompetitorRunPerPair(): Promise<CompetitorRunRow[]> {
  const { rows } = await safeQuery<DbRow>(
    `SELECT DISTINCT ON (tool, target)
            id, run_at, tool, target, recall, precision, findings, report
       FROM instinct_competitor_benchmark_runs
      ORDER BY tool, target, run_at DESC`,
  );
  return rows
    .map(toRunRow)
    .sort((a, b) => new Date(b.runAt).getTime() - new Date(a.runAt).getTime());
}

/**
 * Read OUR latest benchmark score for a SPECIFIC target directly from the DB
 * (fix #5).
 *
 * The old route walked at most 50 recent runs and returned the FIRST one that
 * happened to mention the target - which could (a) present a STALE run if a newer
 * run for the target sat outside that 50-row window, or (b) fall through to a
 * fabricated {recall:0} when the target was outside the window entirely,
 * UNDERSTATING us. This query filters on `report->'perTarget'` actually containing
 * the target and orders by run_at DESC, so we always get the genuine latest run
 * FOR THAT TARGET, carrying run_at so "as of" is knowable.
 *
 * Returns an OurTargetScore. When we truly have no scored run for the target,
 * `hasRun:false` and recall/precision are `null` (UNKNOWN) - never a silent 0,
 * and parity is therefore not claimable. recall/precision are also `null` when the
 * stored per-target score is unlabeled. Degrades to the no-run shape with no DB.
 */
export async function ourLatestScoreForTarget(target: string): Promise<OurTargetScore> {
  const noRun: OurTargetScore = {
    target,
    recall: null,
    precision: null,
    matched: [],
    labeled: false,
    hasRun: false,
    runAt: null,
  };

  // jsonb path: report -> 'perTarget' is an array of {name, ...}; the @> containment
  // test asks "does perTarget contain an element with this name?". Latest first.
  const { rows } = await safeQuery<DbRow>(
    `SELECT run_at, report
       FROM instinct_benchmark_runs
      WHERE report -> 'perTarget' @> $1::jsonb
      ORDER BY run_at DESC
      LIMIT 1`,
    [JSON.stringify([{ name: target }])],
  );
  if (rows.length === 0) return noRun;

  const r = rows[0];
  const report = (r.report ?? {}) as { perTarget?: TargetScore[] };
  const per = (report.perTarget ?? []).find((p) => p.name === target);
  if (!per) return noRun;

  const runAt = r.run_at instanceof Date ? r.run_at.toISOString() : String(r.run_at);
  return {
    target,
    recall: per.labeled ? (typeof per.recall === "number" ? per.recall : null) : null,
    precision: precisionOf(per),
    matched: per.matched ?? [],
    labeled: !!per.labeled,
    hasRun: true,
    runAt,
  };
}
