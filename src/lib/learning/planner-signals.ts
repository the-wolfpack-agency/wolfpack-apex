/**
 * Planner signals — read helpers over instinct_planner_tasks that feed
 * the Assistant brain and cross-module learning loop.
 *
 * Pure reads (no mutations, no analytics). These functions power:
 *   - "Who owns what" workload dashboards
 *   - Plan velocity trendlines
 *   - Bottleneck detection (buckets where cards go to die)
 *
 * No PII flows out of here — assignees are Graph user ids (opaque) and
 * bucket / plan names are the text RAG indexes downstream.
 */

import { safeQuery } from "@/lib/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AssigneeWorkload {
  assignee: string; // Graph user id
  open_count: number;
  complete_count: number;
  overdue_count: number;
}

export interface VelocityPoint {
  date: string; // ISO date
  completed_count: number;
}

export interface BucketHealth {
  bucket_id: string | null; // local UUID or null for unbucketed
  bucket_name: string;
  open_count: number;
  complete_count: number;
  avg_open_age_days: number;
}

// ---------------------------------------------------------------------------
// Workload per assignee
// ---------------------------------------------------------------------------

/**
 * For a given plan, compute per-assignee task counts: open, complete,
 * overdue-and-open. Assignees array is unpacked via jsonb_array_elements_text.
 *
 * Returns rows sorted by (open_count + overdue_count) DESC, capped at 50.
 */
export async function getTeamWorkload(planId: string): Promise<AssigneeWorkload[]> {
  const { rows } = await safeQuery<{
    assignee: string;
    open_count: string;
    complete_count: string;
    overdue_count: string;
  }>(
    `WITH expanded AS (
       SELECT jsonb_array_elements_text(assignees) AS assignee,
              percent_complete,
              due_at
         FROM instinct_planner_tasks
        WHERE plan_id = $1
     )
     SELECT assignee,
            COUNT(*) FILTER (WHERE percent_complete < 100)::text AS open_count,
            COUNT(*) FILTER (WHERE percent_complete = 100)::text AS complete_count,
            COUNT(*) FILTER (
              WHERE percent_complete < 100
                AND due_at IS NOT NULL
                AND due_at < NOW()
            )::text AS overdue_count
       FROM expanded
      GROUP BY assignee
      ORDER BY (
        COUNT(*) FILTER (WHERE percent_complete < 100) +
        COUNT(*) FILTER (
          WHERE percent_complete < 100
            AND due_at IS NOT NULL
            AND due_at < NOW()
        )
      ) DESC
      LIMIT 50`,
    [planId],
  );

  return rows.map((r) => ({
    assignee: r.assignee,
    open_count: Number(r.open_count),
    complete_count: Number(r.complete_count),
    overdue_count: Number(r.overdue_count),
  }));
}

// ---------------------------------------------------------------------------
// Velocity
// ---------------------------------------------------------------------------

/**
 * Tasks completed per day over the last `windowDays`.
 * Gaps are filled with 0-count rows via generate_series, so consumers
 * can render a sparkline without handling nulls.
 */
export async function getPlanVelocity(
  planId: string,
  windowDays: number = 30,
): Promise<VelocityPoint[]> {
  const window = Math.max(1, Math.min(365, Math.floor(windowDays)));
  const { rows } = await safeQuery<{ date: string; completed_count: string }>(
    `WITH days AS (
       SELECT generate_series(
         (NOW() - INTERVAL '1 day' * $2)::date,
         NOW()::date,
         INTERVAL '1 day'
       )::date AS date
     ),
     completed AS (
       SELECT completed_at::date AS date,
              COUNT(*) AS completed_count
         FROM instinct_planner_tasks
        WHERE plan_id = $1
          AND completed_at IS NOT NULL
          AND completed_at > NOW() - INTERVAL '1 day' * $2
        GROUP BY completed_at::date
     )
     SELECT to_char(days.date, 'YYYY-MM-DD') AS date,
            COALESCE(completed.completed_count, 0)::text AS completed_count
       FROM days
       LEFT JOIN completed ON completed.date = days.date
       ORDER BY days.date ASC`,
    [planId, window],
  );

  return rows.map((r) => ({ date: r.date, completed_count: Number(r.completed_count) }));
}

// ---------------------------------------------------------------------------
// Bucket bottlenecks
// ---------------------------------------------------------------------------

/**
 * Buckets with unhealthy aging: high open count + long avg age.
 * Sorted by (open_count * avg_age_days) DESC so the worst offenders
 * float to the top. Caps result set at 20.
 */
export async function getBottleneckBuckets(planId: string): Promise<BucketHealth[]> {
  const { rows } = await safeQuery<{
    bucket_id: string | null;
    bucket_name: string;
    open_count: string;
    complete_count: string;
    avg_open_age_days: string;
  }>(
    `SELECT b.id AS bucket_id,
            COALESCE(b.name, '(unbucketed)') AS bucket_name,
            COUNT(*) FILTER (WHERE t.percent_complete < 100)::text AS open_count,
            COUNT(*) FILTER (WHERE t.percent_complete = 100)::text AS complete_count,
            COALESCE(
              AVG(
                EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 86400.0
              ) FILTER (WHERE t.percent_complete < 100),
              0
            )::text AS avg_open_age_days
       FROM instinct_planner_tasks t
  LEFT JOIN instinct_planner_buckets b ON b.id = t.bucket_id
      WHERE t.plan_id = $1
      GROUP BY b.id, b.name
      ORDER BY (
        COUNT(*) FILTER (WHERE t.percent_complete < 100) *
        COALESCE(
          AVG(EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 86400.0)
            FILTER (WHERE t.percent_complete < 100),
          0
        )
      ) DESC
      LIMIT 20`,
    [planId],
  );

  return rows.map((r) => ({
    bucket_id: r.bucket_id,
    bucket_name: r.bucket_name,
    open_count: Number(r.open_count),
    complete_count: Number(r.complete_count),
    avg_open_age_days: Number(r.avg_open_age_days),
  }));
}
