/**
 * porsche-classes / audit-repo — user-visible audit log for automated
 * actions, with a 24h "undo" window.
 *
 * COMPLEMENTARY to `@/lib/analytics`:
 *   - analytics  → fire-and-forget telemetry, never user-visible.
 *   - this file  → user-visible mutations the operator can SEE + UNDO.
 *
 * Three action kinds today (match the migration 091 CHECK constraint):
 *   - class_match_merge   → an override of kind='class_match' was inserted
 *   - sharepoint_upload   → a class summary was PUT into SharePoint
 *   - survey_auto_split   → a mixed-survey artifact was auto-split into
 *                            synthetic per-class snapshots
 *
 * `recordAction` uses `writeQuery` (strict-write) so a silently dropped
 * audit insert surfaces as a thrown error — the audit trail is the trust
 * surface, it MUST not lose rows. We catch + re-throw at call sites
 * defensively so a failed audit does not poison the underlying action;
 * see the call-sites in sharepoint-upload route, override route, and
 * ingest auto-split path.
 *
 * `revertAction` only marks the audit row reverted_at/reverted_by — the
 * actual revert side-effects live in `audit-revert.ts`. Splitting the
 * concerns this way keeps the audit row authoritative ("did we mark it
 * reverted?") and the revert handler a pure undo function. The route
 * orchestrates: load row → check 24h + not-already-reverted → run revert
 * handler → mark reverted.
 */

import { query, writeQuery } from "@/lib/db";
import type { AutomationId } from "@/lib/automations/types";

// ---------------------------------------------------------------------------
// Types — stay narrow + serializable
// ---------------------------------------------------------------------------

export type AuditActionKind =
  | "class_match_merge"
  | "sharepoint_upload"
  | "survey_auto_split";

/** Detail payloads keyed by action_kind. JSON-serializable. */
export interface AuditDetailByKind {
  class_match_merge: {
    override_id: string;
    from_value: string;
    to_value: string;
    reason?: string | null;
  };
  sharepoint_upload: {
    item_id?: string | null;
    web_url?: string | null;
    filename: string;
  };
  survey_auto_split: {
    snapshot_ids: string[];
    /** Original parse_failure exception that the auto-split replaced. */
    exception_id?: string | null;
    /** The error string we'd have quarantined under, captured for replay. */
    original_error?: string | null;
  };
}

/** The shape of a row returned from the DB / API. */
export interface AuditActionRecord<
  K extends AuditActionKind = AuditActionKind,
> {
  id: string;
  automation_id: string;
  action_kind: K;
  target_ref: string;
  detail: AuditDetailByKind[K];
  actor: string;
  reverted_at: string | null;
  reverted_by: string | null;
  created_at: string;
}

/* ------------------------------------------------------------------ */
/* recordAction                                                        */
/* ------------------------------------------------------------------ */

export interface RecordActionArgs<K extends AuditActionKind = AuditActionKind> {
  automation_id: AutomationId | string;
  action_kind: K;
  target_ref: string;
  detail: AuditDetailByKind[K];
  /** user.email of whoever triggered, or 'system' for cron-driven. */
  actor: string;
}

/**
 * Insert one audit row. Returns the persisted record so callers can
 * reference its id (e.g. to surface "Undo this" buttons immediately).
 *
 * Throws if writeQuery throws — the audit log is the trust surface and
 * silent loss is unacceptable. Call sites SHOULD wrap with a defensive
 * try/catch so a downstream pg outage doesn't bring down the action
 * itself: log + continue, since the action already happened. See
 * sharepoint-upload route + override route for the pattern.
 */
export async function recordAction<K extends AuditActionKind>(
  args: RecordActionArgs<K>,
): Promise<AuditActionRecord<K>> {
  const r = await writeQuery<AuditActionRecord<K> & Record<string, unknown>>(
    `INSERT INTO instinct_automation_audit_actions
       (automation_id, action_kind, target_ref, detail, actor)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING id, automation_id, action_kind, target_ref, detail, actor,
               reverted_at::text AS reverted_at,
               reverted_by,
               created_at::text AS created_at`,
    [
      args.automation_id,
      args.action_kind,
      args.target_ref,
      JSON.stringify(args.detail),
      args.actor,
    ],
    { expectRows: 1 },
  );
  return r.rows[0];
}

/* ------------------------------------------------------------------ */
/* listActionsForClass / listActionsForAutomation                      */
/* ------------------------------------------------------------------ */

export interface ListActionsOptions {
  /** ISO timestamp — only return rows with created_at >= this. */
  since?: string;
  /** Cap rows returned. Defaults to 100, max 500. */
  limit?: number;
}

/**
 * Recent audit rows touching a single class_key (target_ref). Used by
 * the per-class audit history widget on /summaries.
 *
 * NOTE: target_ref is class_key for merges + uploads, and artifact_id for
 * splits — so this query INTENTIONALLY does not return survey_auto_split
 * rows when called with a class_key. The per-automation listing below
 * returns the full mix.
 */
export async function listActionsForClass(
  class_key: string,
  opts: ListActionsOptions = {},
): Promise<AuditActionRecord[]> {
  const limit = clampLimit(opts.limit);
  const params: unknown[] = [class_key];
  let where = "WHERE target_ref = $1";
  if (opts.since) {
    params.push(opts.since);
    where += ` AND created_at >= $${params.length}`;
  }
  const r = await query<AuditActionRecord & Record<string, unknown>>(
    `SELECT id, automation_id, action_kind, target_ref, detail, actor,
            reverted_at::text AS reverted_at,
            reverted_by,
            created_at::text AS created_at
       FROM instinct_automation_audit_actions
       ${where}
      ORDER BY created_at DESC
      LIMIT ${limit}`,
    params,
  );
  return r.rows;
}

/**
 * Recent audit rows for a whole automation. Used by the audit list route
 * (GET /api/automations/[id]/audit). Optional class_key filter narrows to
 * one class.
 */
export async function listActionsForAutomation(args: {
  automation_id: AutomationId | string;
  class_key?: string;
  since?: string;
  limit?: number;
}): Promise<AuditActionRecord[]> {
  const limit = clampLimit(args.limit);
  const params: unknown[] = [args.automation_id];
  let where = "WHERE automation_id = $1";
  if (args.class_key) {
    params.push(args.class_key);
    where += ` AND target_ref = $${params.length}`;
  }
  if (args.since) {
    params.push(args.since);
    where += ` AND created_at >= $${params.length}`;
  }
  const r = await query<AuditActionRecord & Record<string, unknown>>(
    `SELECT id, automation_id, action_kind, target_ref, detail, actor,
            reverted_at::text AS reverted_at,
            reverted_by,
            created_at::text AS created_at
       FROM instinct_automation_audit_actions
       ${where}
      ORDER BY created_at DESC
      LIMIT ${limit}`,
    params,
  );
  return r.rows;
}

/* ------------------------------------------------------------------ */
/* getActionById                                                       */
/* ------------------------------------------------------------------ */

/** Fetch a single audit row by id. Returns null when the row is gone. */
export async function getActionById(
  action_id: string,
): Promise<AuditActionRecord | null> {
  const r = await query<AuditActionRecord & Record<string, unknown>>(
    `SELECT id, automation_id, action_kind, target_ref, detail, actor,
            reverted_at::text AS reverted_at,
            reverted_by,
            created_at::text AS created_at
       FROM instinct_automation_audit_actions
      WHERE id = $1
      LIMIT 1`,
    [action_id],
  );
  return r.rows[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* revertAction — DB-side mark only                                    */
/* ------------------------------------------------------------------ */

/**
 * Mark an audit row reverted. Idempotent on already-reverted: we use a
 * `WHERE reverted_at IS NULL` guard so a double-click doesn't move the
 * timestamp. Returns the updated row, or null when:
 *   - the row doesn't exist
 *   - the row was already reverted
 *
 * NOTE: this function does NOT execute the actual undo side-effects.
 * That lives in `audit-revert.ts` so the SQL state and the undo logic
 * stay separately auditable. The route is responsible for orchestrating:
 *   1. getActionById
 *   2. age check (24h window)
 *   3. revert handler (audit-revert.ts)
 *   4. revertAction (this file) — only flip if the handler succeeded.
 */
export async function revertAction(
  action_id: string,
  reverted_by: string,
): Promise<AuditActionRecord | null> {
  const r = await writeQuery<AuditActionRecord & Record<string, unknown>>(
    `UPDATE instinct_automation_audit_actions
        SET reverted_at = NOW(),
            reverted_by = $2
      WHERE id = $1
        AND reverted_at IS NULL
      RETURNING id, automation_id, action_kind, target_ref, detail, actor,
                reverted_at::text AS reverted_at,
                reverted_by,
                created_at::text AS created_at`,
    [action_id, reverted_by],
  );
  return r.rows[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * 24h "still revertable" check — keeps this constant in ONE place so the
 * route, the UI, and the docs stay in lockstep.
 */
export const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Returns true when the row's created_at is within the 24h undo window.
 * Defensive against bad timestamps: an unparseable created_at returns
 * false (treat as expired) rather than throwing — we'd rather refuse
 * the undo than crash the route.
 */
export function isWithinUndoWindow(
  created_at: string,
  now: Date = new Date(),
): boolean {
  const t = Date.parse(created_at);
  if (Number.isNaN(t)) return false;
  return now.getTime() - t < UNDO_WINDOW_MS;
}

function clampLimit(raw: number | undefined): number {
  const n = Math.floor(raw ?? 100);
  if (!Number.isFinite(n) || n < 1) return 100;
  return Math.min(n, 500);
}
