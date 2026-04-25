/**
 * automations / queries — read-side helpers used by the API routes.
 *
 * Pure SQL — no business logic. Keeps the API routes thin and lets the
 * test suite exercise queries in isolation.
 */

import { query, writeQuery } from "@/lib/db";
import type {
  AutomationId,
  DeltaRecord,
  ExceptionKind,
  ExceptionRecord,
  OverrideKind,
  OverrideRecord,
} from "./types";

/* ------------------------------------------------------------------ */
/* Counts for the dashboard tile                                       */
/* ------------------------------------------------------------------ */

export interface AutomationCounts {
  /** Distinct artifacts received in the last 24h. */
  artifacts_today: number;
  /** Distinct artifacts received in the last 7 days. */
  artifacts_this_week: number;
  /** Total distinct artifacts ever received. */
  artifacts_total: number;
  /** Open exceptions across the automation. */
  open_exceptions: number;
  /** Distinct class_keys with a captured snapshot inside the active window. */
  classes_in_window: number;
}

export async function getAutomationCounts(args: {
  automationId: AutomationId;
  windowMinDays: number; // negative = days in the past, positive = future
  windowMaxDays: number;
}): Promise<AutomationCounts> {
  const r = await query<{
    artifacts_today: string;
    artifacts_this_week: string;
    artifacts_total: string;
    open_exceptions: string;
    classes_in_window: string;
  }>(
    `SELECT
       (SELECT COUNT(*)::int FROM instinct_automation_porsche_artifacts
         WHERE automation_id = $1
           AND received_at > NOW() - INTERVAL '24 hours')::text AS artifacts_today,
       (SELECT COUNT(*)::int FROM instinct_automation_porsche_artifacts
         WHERE automation_id = $1
           AND received_at > NOW() - INTERVAL '7 days')::text AS artifacts_this_week,
       (SELECT COUNT(*)::int FROM instinct_automation_porsche_artifacts
         WHERE automation_id = $1)::text AS artifacts_total,
       (SELECT COUNT(*)::int FROM instinct_automation_porsche_exceptions
         WHERE automation_id = $1
           AND status = 'open')::text AS open_exceptions,
       (SELECT COUNT(DISTINCT class_key)::int
          FROM instinct_automation_porsche_snapshots
         WHERE class_date BETWEEN
           (CURRENT_DATE + ($2 || ' days')::INTERVAL)::date
           AND (CURRENT_DATE + ($3 || ' days')::INTERVAL)::date
       )::text AS classes_in_window`,
    [args.automationId, String(args.windowMinDays), String(args.windowMaxDays)],
  );
  return {
    artifacts_today: Number(r.rows[0]?.artifacts_today ?? 0),
    artifacts_this_week: Number(r.rows[0]?.artifacts_this_week ?? 0),
    artifacts_total: Number(r.rows[0]?.artifacts_total ?? 0),
    open_exceptions: Number(r.rows[0]?.open_exceptions ?? 0),
    classes_in_window: Number(r.rows[0]?.classes_in_window ?? 0),
  };
}

/* ------------------------------------------------------------------ */
/* Delta digest — Mon/Fri-style rollup                                 */
/* ------------------------------------------------------------------ */

export interface ChangeDigestRow {
  class_key: string;
  course_type: string;
  class_date: string;
  location: string;
  /** Latest snapshot timestamp for this class. */
  last_captured_at: string;
  /** Latest delta row for this class. */
  added: string[];
  dropped: string[];
  net_change: number;
  is_baseline: boolean;
  delta_created_at: string;
}

export async function getChangeDigest(args: {
  automationId: AutomationId;
  windowMinDays: number;
  windowMaxDays: number;
}): Promise<ChangeDigestRow[]> {
  // For each class_key, take the LATEST delta row. Then join the
  // snapshot to grab class_date / location / course_type.
  // DISTINCT ON keeps this O(n) on the (class_key, created_at desc) index.
  const r = await query<{
    class_key: string;
    course_type: string;
    class_date: string;
    location: string;
    last_captured_at: string;
    added: string[];
    dropped: string[];
    net_change: number;
    is_baseline: boolean;
    delta_created_at: string;
  }>(
    `SELECT DISTINCT ON (d.class_key)
            d.class_key,
            s.course_type,
            s.class_date::text AS class_date,
            s.location,
            s.captured_at::text AS last_captured_at,
            d.added,
            d.dropped,
            d.net_change,
            d.is_baseline,
            d.created_at::text AS delta_created_at
       FROM instinct_automation_porsche_deltas d
       JOIN instinct_automation_porsche_snapshots s
         ON s.id = d.curr_snapshot_id
      WHERE d.automation_id = $1
        AND s.class_date BETWEEN
              (CURRENT_DATE + ($2 || ' days')::INTERVAL)::date
              AND (CURRENT_DATE + ($3 || ' days')::INTERVAL)::date
      ORDER BY d.class_key, d.created_at DESC`,
    [args.automationId, String(args.windowMinDays), String(args.windowMaxDays)],
  );
  return r.rows.map((row) => ({
    class_key: row.class_key,
    course_type: row.course_type,
    class_date: row.class_date,
    location: row.location,
    last_captured_at: row.last_captured_at,
    added: Array.isArray(row.added) ? row.added : [],
    dropped: Array.isArray(row.dropped) ? row.dropped : [],
    net_change: row.net_change,
    is_baseline: row.is_baseline,
    delta_created_at: row.delta_created_at,
  }));
}

/* ------------------------------------------------------------------ */
/* Exception list                                                      */
/* ------------------------------------------------------------------ */

// pg's QueryResult generic requires a Record<string, unknown> shape; we
// cast at the boundary (these row shapes match the typed records but TS
// won't accept them as Record-shapes without an explicit assertion).
type ExceptionRow = ExceptionRecord & Record<string, unknown>;
type OverrideRow = OverrideRecord & Record<string, unknown>;

export async function listExceptions(args: {
  automationId: AutomationId;
  status?: "open" | "resolved" | "dismissed" | "all";
  limit?: number;
}): Promise<ExceptionRecord[]> {
  const status = args.status ?? "open";
  const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
  const params: unknown[] = [args.automationId];
  let where = "WHERE automation_id = $1";
  if (status !== "all") {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }
  const r = await query<ExceptionRow>(
    `SELECT id, automation_id, artifact_id, kind, detail, status,
            resolved_by, resolved_at::text AS resolved_at,
            created_at::text AS created_at
       FROM instinct_automation_porsche_exceptions
       ${where}
      ORDER BY created_at DESC
      LIMIT ${limit}`,
    params,
  );
  return r.rows;
}

/* ------------------------------------------------------------------ */
/* Resolve / dismiss exception                                         */
/* ------------------------------------------------------------------ */

export async function resolveException(args: {
  exceptionId: string;
  resolvedBy: string;
  outcome: "resolved" | "dismissed";
}): Promise<ExceptionRecord | null> {
  const r = await writeQuery<ExceptionRow>(
    `UPDATE instinct_automation_porsche_exceptions
        SET status      = $2,
            resolved_by = $3,
            resolved_at = NOW()
      WHERE id = $1
        AND status = 'open'
      RETURNING id, automation_id, artifact_id, kind, detail, status,
                resolved_by, resolved_at::text AS resolved_at,
                created_at::text AS created_at`,
    [args.exceptionId, args.outcome, args.resolvedBy],
  );
  return r.rows[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Override insert                                                     */
/* ------------------------------------------------------------------ */

export async function insertOverride(args: {
  automationId: AutomationId;
  kind: OverrideKind;
  fromValue: string;
  toValue: string;
  reason: string | null;
  createdBy: string;
}): Promise<OverrideRecord> {
  const r = await writeQuery<OverrideRow>(
    `INSERT INTO instinct_automation_porsche_overrides
       (automation_id, kind, from_value, to_value, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, automation_id, kind, from_value, to_value, reason,
               created_by, created_at::text AS created_at`,
    [
      args.automationId,
      args.kind,
      args.fromValue,
      args.toValue,
      args.reason,
      args.createdBy,
    ],
    { expectRows: 1 },
  );
  return r.rows[0];
}

/* ------------------------------------------------------------------ */
/* Override list                                                       */
/* ------------------------------------------------------------------ */

export async function listOverrides(args: {
  automationId: AutomationId;
  kind?: OverrideKind;
}): Promise<OverrideRecord[]> {
  const params: unknown[] = [args.automationId];
  let where = "WHERE automation_id = $1";
  if (args.kind) {
    params.push(args.kind);
    where += ` AND kind = $${params.length}`;
  }
  const r = await query<OverrideRow>(
    `SELECT id, automation_id, kind, from_value, to_value, reason,
            created_by, created_at::text AS created_at
       FROM instinct_automation_porsche_overrides
       ${where}
      ORDER BY created_at DESC
      LIMIT 200`,
    params,
  );
  return r.rows;
}

/* ------------------------------------------------------------------ */
/* Get the bytes of a single artifact (for the "Open artifact" link)   */
/* ------------------------------------------------------------------ */

export async function getArtifactBytes(args: {
  artifactId: string;
}): Promise<{ bytes: Buffer; mime: string; received_at: string } | null> {
  const r = await query<{ bytes: Buffer; mime: string; received_at: string }>(
    `SELECT bytes, mime, received_at::text AS received_at
       FROM instinct_automation_porsche_artifacts
      WHERE id = $1`,
    [args.artifactId],
  );
  if (r.rows.length === 0) return null;
  return r.rows[0];
}

/* ------------------------------------------------------------------ */
/* (Re-export typed shapes used by API routes)                         */
/* ------------------------------------------------------------------ */

export type { DeltaRecord, ExceptionKind };
