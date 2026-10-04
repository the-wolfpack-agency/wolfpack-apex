/**
 * Loop efficacy: "is the factory actually getting better over time?" - the
 * measurement the improve-over-time work needs, read from the event stream.
 *
 * If the brain works, over a window you should see first-pass ready-rate and
 * acceptance-rate RISE and the repeat-finding rate FALL (fewer re-caught mistakes
 * as the failure memory warns the author). We compute those rates + a recent-vs-
 * prior TREND so the direction is explicit, not guessed.
 *
 * Pure summarizer (unit-tested) + a never-throwing loader (safeQuery -> zeros).
 * Workspace-scoped. No new table: it reads the signals the pipeline already emits
 * (ai_code.pipeline_run / finding_detected / pr_merged / pr_closed_unmerged).
 */
import { safeQuery } from "@/lib/db";

export type Trend = "up" | "down" | "flat" | "n/a";

export interface LoopEfficacyCounts {
  runs: number;
  ready: number;
  dupEscalated: number;
  semanticRuns: number;
  merged: number;
  closed: number;
  findingsTotal: number;
  findingClassesDistinct: number;
  recentRuns: number;
  recentReady: number;
  priorRuns: number;
  priorReady: number;
}

export interface LoopEfficacy {
  windowDays: number;
  runs: number;
  /** ready_for_pr / runs - how often a first pass is clean enough to hand off. */
  firstPassReadyRate: number | null;
  /** merged / (merged + closed-unmerged) - does the work actually ship. */
  acceptanceRate: number | null;
  /** runs the DRY gate escalated as a likely duplicate / runs. */
  duplicationRate: number | null;
  /** runs that used the semantic reuse brain / runs. */
  reuseSemanticRate: number | null;
  /** (findings - distinct classes) / findings - the share of catches that REPEAT
   *  a class already seen. The brain should push this DOWN over time. */
  repeatFindingRate: number | null;
  /** Direction of first-pass ready-rate, recent half vs prior half. */
  readyTrend: Trend;
}

const rate = (n: number, d: number): number | null => (d > 0 ? n / d : null);

/** Classify a recent-vs-prior rate move. `eps` avoids flapping on noise. */
export function trendOf(recent: number | null, prior: number | null, eps = 0.05): Trend {
  if (recent === null || prior === null) return "n/a";
  if (recent - prior > eps) return "up";
  if (prior - recent > eps) return "down";
  return "flat";
}

/** Pure: turn raw counts into rates + a trend. */
export function summarizeLoopEfficacy(c: LoopEfficacyCounts, windowDays: number): LoopEfficacy {
  const recentReadyRate = rate(c.recentReady, c.recentRuns);
  const priorReadyRate = rate(c.priorReady, c.priorRuns);
  return {
    windowDays,
    runs: c.runs,
    firstPassReadyRate: rate(c.ready, c.runs),
    acceptanceRate: rate(c.merged, c.merged + c.closed),
    duplicationRate: rate(c.dupEscalated, c.runs),
    reuseSemanticRate: rate(c.semanticRuns, c.runs),
    repeatFindingRate: rate(c.findingsTotal - c.findingClassesDistinct, c.findingsTotal),
    readyTrend: trendOf(recentReadyRate, priorReadyRate),
  };
}

const EMPTY: LoopEfficacyCounts = {
  runs: 0, ready: 0, dupEscalated: 0, semanticRuns: 0, merged: 0, closed: 0,
  findingsTotal: 0, findingClassesDistinct: 0, recentRuns: 0, recentReady: 0, priorRuns: 0, priorReady: 0,
};

/** Load the efficacy metrics for a workspace over `days`. Never throws (zeros on
 *  failure). All values are query params - no string interpolation into SQL. */
export async function loadLoopEfficacy(workspaceId: string, days = 30): Promise<LoopEfficacy> {
  const d = Math.min(Math.max(Math.trunc(days), 2), 365);
  const win = `timestamp > now() - ($1 || ' days')::interval AND metadata->>'workspace_id' = $2`;
  // Half-window boundary for the recent-vs-prior trend split.
  const half = `now() - ((($1::int) / 2)::text || ' days')::interval`;

  const runs = await safeQuery<{ runs: number; ready: number; dup: number; semantic: number; recent_runs: number; recent_ready: number; prior_runs: number; prior_ready: number }>(
    `SELECT
       count(*)::int AS runs,
       count(*) FILTER (WHERE metadata->>'status' = 'ready_for_pr')::int AS ready,
       count(*) FILTER (WHERE metadata->>'reuse_duplication_escalated' = 'true')::int AS dup,
       count(*) FILTER (WHERE metadata->>'reuse_semantic' = 'true')::int AS semantic,
       count(*) FILTER (WHERE timestamp > ${half})::int AS recent_runs,
       count(*) FILTER (WHERE timestamp > ${half} AND metadata->>'status' = 'ready_for_pr')::int AS recent_ready,
       count(*) FILTER (WHERE timestamp <= ${half})::int AS prior_runs,
       count(*) FILTER (WHERE timestamp <= ${half} AND metadata->>'status' = 'ready_for_pr')::int AS prior_ready
       FROM instinct_events
      WHERE event_type = 'ai_code.pipeline_run' AND ${win}`,
    [String(d), workspaceId],
  );
  const prs = await safeQuery<{ merged: number; closed: number }>(
    `SELECT
       count(*) FILTER (WHERE event_type = 'ai_code.pr_merged')::int AS merged,
       count(*) FILTER (WHERE event_type = 'ai_code.pr_closed_unmerged')::int AS closed
       FROM instinct_events
      WHERE event_type IN ('ai_code.pr_merged', 'ai_code.pr_closed_unmerged') AND ${win}`,
    [String(d), workspaceId],
  );
  const finds = await safeQuery<{ total: number; distinct_classes: number }>(
    `SELECT count(*)::int AS total, count(DISTINCT metadata->>'class')::int AS distinct_classes
       FROM instinct_events
      WHERE event_type = 'ai_code.finding_detected' AND ${win}`,
    [String(d), workspaceId],
  );

  const r = runs.rows[0];
  const p = prs.rows[0];
  const f = finds.rows[0];
  const counts: LoopEfficacyCounts = {
    ...EMPTY,
    runs: Number(r?.runs ?? 0),
    ready: Number(r?.ready ?? 0),
    dupEscalated: Number(r?.dup ?? 0),
    semanticRuns: Number(r?.semantic ?? 0),
    recentRuns: Number(r?.recent_runs ?? 0),
    recentReady: Number(r?.recent_ready ?? 0),
    priorRuns: Number(r?.prior_runs ?? 0),
    priorReady: Number(r?.prior_ready ?? 0),
    merged: Number(p?.merged ?? 0),
    closed: Number(p?.closed ?? 0),
    findingsTotal: Number(f?.total ?? 0),
    findingClassesDistinct: Number(f?.distinct_classes ?? 0),
  };
  return summarizeLoopEfficacy(counts, d);
}
