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
import type { CompetitiveReport, CompetitorTool } from "./competitive";

/** A persisted competitor run, shaped for the dashboard comparison. */
export interface CompetitorRunRow {
  id: string;
  runAt: string;
  tool: CompetitorTool;
  target: string;
  recall: number;
  precision: number;
  findings: number;
  report: CompetitiveReport;
}

type DbRow = Record<string, unknown>;

function toRunRow(r: DbRow): CompetitorRunRow {
  return {
    id: String(r.id),
    runAt: r.run_at instanceof Date ? r.run_at.toISOString() : String(r.run_at),
    tool: String(r.tool) as CompetitorTool,
    target: String(r.target),
    recall: Number(r.recall) || 0,
    precision: Number(r.precision) || 0,
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
  recall: number;
  precision: number;
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
