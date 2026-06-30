/**
 * OGIAM governance DRIFT TRENDS: time-series rollups of the governance signals.
 *
 * The renewal story is "the line goes down and stays down": governance has to be
 * OPERATIONAL over time, not a one-shot snapshot. This module turns the three
 * durable governance signals into day-bucketed series the admin trends view
 * renders as sparklines:
 *
 *   1. Gate-decision volume + outcome mix over time  (ogiam_decisions)
 *   2. Red-team pass-rate history                    (instinct_ai_redteam_runs)
 *   3. Ungoverned-AI-surface count over time         (instinct_ai_surfaces)
 *
 * TECH CHOICE — aggregation strategy: on-read SQL `date_trunc('day', created_at)
 * GROUP BY`, NOT a materialized view or a precomputed rollup table. Rationale:
 *   - At current data volumes (a single primary tenant, thousands of decision
 *     rows, hundreds of red-team runs) a windowed GROUP BY over the existing
 *     (workspace_id, created_at) indexes is fast and exact.
 *   - It adds ZERO new write paths: no rollup table to keep in sync, no MV to
 *     refresh on a schedule, no risk of a stale or drifting derived store. The
 *     trends are always consistent with the source ledgers by construction.
 *   - It is DRY: the same source tables the explorer / red-team / inventory
 *     surfaces already read.
 * GRADUATE to a precomputed rollup table (or a `CREATE MATERIALIZED VIEW` with a
 * scheduled REFRESH) when a workspace's decision ledger grows past ~1M rows or the
 * window widens to multi-year, at which point the per-request GROUP BY scan cost
 * stops being negligible. Until then, on-read is the deliberate, simplest choice.
 *
 * Reads only. Every query is workspace-scoped on the parameterized `workspace_id`
 * and a parameterized day window, and goes through `safeQuery`, so a missing
 * DATABASE_URL or a transient DB error degrades to empty series (fromCache=true)
 * rather than throwing into the route. The route translates that into a 503.
 *
 * The pure `bucketDecisions` / `fillDailyBuckets` keep the aggregation logic unit-
 * testable from synthetic rows without a DB.
 */

import { safeQuery } from "@/lib/db";

/** Default + clamp bounds for the trend window, in days. */
export const OGIAM_TRENDS_DEFAULT_WINDOW_DAYS = 30;
export const OGIAM_TRENDS_MAX_WINDOW_DAYS = 365;

/** Clamp a requested window (days) into [1, MAX], default when absent/invalid. */
export function clampWindowDays(raw: number | undefined): number {
  const n = Number.isFinite(raw) ? Number(raw) : OGIAM_TRENDS_DEFAULT_WINDOW_DAYS;
  return Math.min(Math.max(Math.trunc(n), 1), OGIAM_TRENDS_MAX_WINDOW_DAYS);
}

/** One day bucket of gate decisions: total + how many would have been blocked. */
export interface DecisionBucket {
  /** ISO date (YYYY-MM-DD) for the bucket. */
  day: string;
  total: number;
  would_block: number;
}

/** One day bucket of red-team assurance: the day's latest pass rate + vuln count. */
export interface RedTeamBucket {
  day: string;
  /** Pass rate (0..1) of the LAST run that day; null if no run that day. */
  pass_rate: number | null;
  /** Vulns found by the last run that day. */
  vulns: number;
  runs: number;
}

/** One day bucket of the AI-surface inventory: how many ungoverned surfaces
 *  had been discovered (cumulative, by first_seen_at) as of that day. */
export interface SurfaceBucket {
  day: string;
  /** New ungoverned surfaces first seen that day. */
  new_ungoverned: number;
  /** Cumulative ungoverned surfaces discovered through that day. */
  cumulative_ungoverned: number;
}

/** The full trends payload the admin view renders. */
export interface GovernanceTrends {
  window_days: number;
  decisions: DecisionBucket[];
  redteam: RedTeamBucket[];
  surfaces: SurfaceBucket[];
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable without a DB)
// ---------------------------------------------------------------------------

/** A raw decision row for bucketing: just the day + would_block flag. */
export interface RawDecisionRow {
  created_at: string;
  would_block: boolean;
}

/** Truncate an ISO timestamp to its YYYY-MM-DD day (UTC). */
export function dayOf(iso: string): string {
  // Already day-shaped? pass through. Otherwise take the date portion of the ISO.
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

/**
 * Pure rollup of raw decision rows into per-day buckets (total + would_block),
 * sorted ascending by day. Used by the query fn and exercised directly by the
 * unit tests with synthetic rows.
 */
export function bucketDecisions(rows: RawDecisionRow[]): DecisionBucket[] {
  const byDay = new Map<string, DecisionBucket>();
  for (const r of rows) {
    const day = dayOf(r.created_at);
    const b = byDay.get(day) ?? { day, total: 0, would_block: 0 };
    b.total += 1;
    if (r.would_block) b.would_block += 1;
    byDay.set(day, b);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** A raw surface row for bucketing: the day it was first seen + governed flag. */
export interface RawSurfaceRow {
  first_seen_at: string;
  governed: boolean;
}

/**
 * Pure rollup of ungoverned-surface discovery into per-day buckets, with a
 * running cumulative count so the trend reads as "ungoverned surfaces over time"
 * (the gap that should shrink as surfaces get governed). Governed surfaces are
 * excluded — the signal is the UNGOVERNED count. Sorted ascending by day.
 */
export function bucketSurfaces(rows: RawSurfaceRow[]): SurfaceBucket[] {
  const byDay = new Map<string, number>();
  for (const r of rows) {
    if (r.governed) continue;
    const day = dayOf(r.first_seen_at);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const days = [...byDay.keys()].sort((a, b) => a.localeCompare(b));
  let cumulative = 0;
  return days.map((day) => {
    const n = byDay.get(day) ?? 0;
    cumulative += n;
    return { day, new_ungoverned: n, cumulative_ungoverned: cumulative };
  });
}

/** A raw red-team run for bucketing: day, pass rate, vuln count. */
export interface RawRedTeamRow {
  created_at: string;
  pass_rate: number;
  vulns: number;
}

/**
 * Pure rollup of red-team runs into per-day buckets. Multiple runs in a day
 * collapse to the LAST run's pass rate + vuln count (the most recent assurance
 * state that day), plus a run count. Sorted ascending by day. Assumes `rows` are
 * in DESC created_at order (as the store returns them); the first row seen for a
 * day wins as "last".
 */
export function bucketRedTeam(rows: RawRedTeamRow[]): RedTeamBucket[] {
  const byDay = new Map<string, RedTeamBucket>();
  // rows are newest-first; the first row for a day is that day's latest run.
  for (const r of rows) {
    const day = dayOf(r.created_at);
    const existing = byDay.get(day);
    if (!existing) {
      byDay.set(day, {
        day,
        pass_rate: Number.isFinite(r.pass_rate) ? Number(r.pass_rate) : null,
        vulns: Number.isFinite(r.vulns) ? Number(r.vulns) : 0,
        runs: 1,
      });
    } else {
      existing.runs += 1;
    }
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

// ---------------------------------------------------------------------------
// Query fns (workspace-scoped, parameterized, degrade to [] on cache/DB miss)
// ---------------------------------------------------------------------------

interface DecisionDayRow {
  day: string;
  total: string | number;
  would_block: string | number;
}

function toInt(v: string | number | null | undefined): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Gate-decision volume + outcome mix per day for a workspace, within the last
 * `windowDays`. On-read date_trunc GROUP BY over the (workspace_id, created_at)
 * index; parameterized on both workspace and window.
 */
export async function decisionTrend(
  workspaceId: string,
  windowDays: number,
): Promise<DecisionBucket[]> {
  const days = clampWindowDays(windowDays);
  const res = await safeQuery<DecisionDayRow>(
    `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE would_block)::int AS would_block
       FROM ogiam_decisions
      WHERE workspace_id = $1
        AND created_at > NOW() - make_interval(days => $2)
      GROUP BY 1
      ORDER BY 1 ASC`,
    [workspaceId, days],
  );
  return res.rows.map((r) => ({
    day: r.day,
    total: toInt(r.total),
    would_block: toInt(r.would_block),
  }));
}

interface RedTeamDayRow {
  day: string;
  pass_rate: string | number | null;
  vulns: string | number;
  runs: string | number;
}

/**
 * Red-team pass-rate history per day for a workspace, within the last
 * `windowDays`. DISTINCT ON picks the LATEST run per day (newest created_at), so
 * the series is the most recent assurance state each day; a separate count gives
 * total runs that day. Parameterized on workspace + window.
 */
export async function redTeamTrend(
  workspaceId: string,
  windowDays: number,
): Promise<RedTeamBucket[]> {
  const days = clampWindowDays(windowDays);
  const res = await safeQuery<RedTeamDayRow>(
    `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
            latest.pass_rate AS pass_rate,
            latest.vulns AS vulns,
            d.runs AS runs
       FROM (
         SELECT date_trunc('day', created_at) AS day, COUNT(*)::int AS runs
           FROM instinct_ai_redteam_runs
          WHERE workspace_id = $1
            AND created_at > NOW() - make_interval(days => $2)
          GROUP BY 1
       ) d
       JOIN LATERAL (
         SELECT r.pass_rate, r.vulns
           FROM instinct_ai_redteam_runs r
          WHERE r.workspace_id = $1
            AND date_trunc('day', r.created_at) = d.day
          ORDER BY r.created_at DESC
          LIMIT 1
       ) latest ON true
      ORDER BY d.day ASC`,
    [workspaceId, days],
  );
  return res.rows.map((r) => ({
    day: r.day,
    pass_rate: r.pass_rate == null ? null : Number(r.pass_rate),
    vulns: toInt(r.vulns),
    runs: toInt(r.runs),
  }));
}

interface SurfaceDayRow {
  day: string;
  new_ungoverned: string | number;
}

/**
 * Ungoverned-AI-surface discovery per day (by first_seen_at) for a workspace,
 * within the last `windowDays`, with a running cumulative computed in JS (the
 * window is bounded so the cumulative is "discovered within the window"). Only
 * ungoverned surfaces count — the signal is the gap that should shrink.
 * Parameterized on workspace + window.
 */
export async function surfaceTrend(
  workspaceId: string,
  windowDays: number,
): Promise<SurfaceBucket[]> {
  const days = clampWindowDays(windowDays);
  const res = await safeQuery<SurfaceDayRow>(
    `SELECT to_char(date_trunc('day', first_seen_at), 'YYYY-MM-DD') AS day,
            COUNT(*)::int AS new_ungoverned
       FROM instinct_ai_surfaces
      WHERE workspace_id = $1
        AND governed = false
        AND first_seen_at > NOW() - make_interval(days => $2)
      GROUP BY 1
      ORDER BY 1 ASC`,
    [workspaceId, days],
  );
  let cumulative = 0;
  return res.rows.map((r) => {
    const n = toInt(r.new_ungoverned);
    cumulative += n;
    return { day: r.day, new_ungoverned: n, cumulative_ungoverned: cumulative };
  });
}

/**
 * The full governance trends payload for a workspace within the window: the three
 * day-bucketed series, fetched in parallel. Each leg degrades to [] independently.
 */
export async function governanceTrends(
  workspaceId: string,
  windowDays?: number,
): Promise<GovernanceTrends> {
  const days = clampWindowDays(windowDays);
  const [decisions, redteam, surfaces] = await Promise.all([
    decisionTrend(workspaceId, days),
    redTeamTrend(workspaceId, days),
    surfaceTrend(workspaceId, days),
  ]);
  return { window_days: days, decisions, redteam, surfaces };
}
