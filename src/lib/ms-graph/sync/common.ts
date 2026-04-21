/**
 * Shared sync helpers for the MS Graph canonical-mirror workers.
 *
 * Each worker in this folder (events, tasks, messages, contacts, files)
 * follows the same lifecycle:
 *
 *   1. Load stored deltaLink from `instinct_ms_sync_cursors`.
 *   2. Call the matching `listXDelta()` helper from `../client`.
 *   3. For every item:
 *        - if `@removed` → upsert deleted_at + append change_log("deleted")
 *        - else          → upsert into the entity table + append
 *                           change_log("created") or ("updated")
 *   4. Save the new deltaLink back to `instinct_ms_sync_cursors`.
 *   5. Emit `ms_sync.user_synced` with per-run counters.
 *
 * Errors:
 *   - `scope_missing`  → emit `ms_sync.scope_missing` and return
 *                         { created:0, updated:0, deleted:0,
 *                           error:"scope_missing" }. Never throws.
 *   - `rate_limited`   → emit `ms_sync.rate_limited`; cursor not advanced.
 *   - anything else    → emit `ms_sync.error`; cursor not advanced.
 *
 * The unified dispatcher in `./index.ts` relies on all workers returning
 * the shape `SyncWorkerResult` without throwing, so one worker's failure
 * never cascades into another's.
 */

import { query, safeQuery, writeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { describeGraphError, GraphClientError } from "../client";

export type MsEntityType = "events" | "tasks" | "messages" | "contacts" | "files";

export interface SyncWorkerResult {
  entityType: MsEntityType;
  created: number;
  updated: number;
  deleted: number;
  durationMs: number;
  error?:
    | "scope_missing"
    | "rate_limited"
    | "unauthorized"
    | "network_error"
    | "graph_error"
    | "no_token"
    | "unknown";
  errorMessage?: string;
  retryAfterSec?: number;
}

// ---------------------------------------------------------------------------
// Cursor storage
// ---------------------------------------------------------------------------

/**
 * Read the saved deltaLink for (user_id, entity_type) or undefined if
 * none stored yet (first sync).
 */
export async function loadCursor(
  userId: string,
  entity: MsEntityType,
): Promise<string | undefined> {
  const { rows } = await safeQuery<{ delta_link: string | null }>(
    `SELECT delta_link FROM instinct_ms_sync_cursors
      WHERE user_id = $1 AND entity_type = $2
      LIMIT 1`,
    [userId, entity],
  );
  const row = rows[0];
  return row?.delta_link ?? undefined;
}

/**
 * Persist the new deltaLink. Strict — a silently-dropped cursor update
 * means the next sync would re-read everything since day zero, so this
 * goes through writeQuery with expectRows:1.
 */
export async function saveCursor(
  userId: string,
  entity: MsEntityType,
  deltaLink: string,
): Promise<void> {
  await writeQuery(
    `INSERT INTO instinct_ms_sync_cursors
       (user_id, entity_type, delta_link, last_synced_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id, entity_type) DO UPDATE SET
       delta_link     = EXCLUDED.delta_link,
       last_synced_at = now()
     RETURNING user_id`,
    [userId, entity, deltaLink],
    { expectRows: 1 },
  );
}

// ---------------------------------------------------------------------------
// Change log
// ---------------------------------------------------------------------------

export async function appendChangeLog(
  userId: string,
  entity: MsEntityType,
  entityId: string,
  changeType: "created" | "updated" | "deleted",
): Promise<void> {
  await writeQuery(
    `INSERT INTO instinct_ms_change_log
       (user_id, entity_type, entity_id, change_type, occurred_at)
     VALUES ($1, $2, $3, $4, now())
     RETURNING id`,
    [userId, entity, entityId, changeType],
    { expectRows: 1 },
  );
}

// ---------------------------------------------------------------------------
// Soft-delete helper — shared by every entity
// ---------------------------------------------------------------------------

/**
 * Mark the mirrored row as deleted. Returns true when a row was found
 * and updated, false when no matching row existed (Graph emitted
 * @removed for an item we never saw — common on first sync).
 */
export async function softDelete(
  table: string,
  userId: string,
  externalId: string,
): Promise<boolean> {
  // table name is a literal passed from each worker — never user input.
  const { rows } = await query<{ id: string }>(
    `UPDATE ${table}
        SET deleted_at = now(),
            updated_at = now()
      WHERE user_id = $1
        AND external_id = $2
        AND deleted_at IS NULL
      RETURNING id`,
    [userId, externalId],
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export function emitSynced(
  userId: string,
  entity: MsEntityType,
  result: SyncWorkerResult,
): void {
  trackEvent("ms_sync.user_synced", userId, "system", {
    user_id: userId,
    entity_type: entity,
    created: result.created,
    updated: result.updated,
    deleted: result.deleted,
    duration_ms: result.durationMs,
  });
}

export function emitScopeMissing(
  userId: string,
  entity: MsEntityType,
  scope: string,
): void {
  trackEvent("ms_sync.scope_missing", userId, "system", {
    entity_type: entity,
    scope,
  });
}

export function emitError(
  userId: string,
  entity: MsEntityType,
  error: string,
  status: number,
): void {
  trackEvent("ms_sync.error", userId, "system", {
    entity_type: entity,
    error,
    status,
  });
}

export function emitRateLimited(
  userId: string,
  entity: MsEntityType,
  retryAfterSec: number,
): void {
  trackEvent("ms_sync.rate_limited", userId, "system", {
    entity_type: entity,
    retry_after_sec: retryAfterSec,
  });
}

// ---------------------------------------------------------------------------
// Error → typed result mapper (never throws)
// ---------------------------------------------------------------------------

/**
 * Convert an unexpected worker exception into a SyncWorkerResult. Emits
 * the matching analytics event before returning. Used by every worker's
 * top-level try/catch so the dispatcher gets a uniform shape.
 */
export function errorToResult(
  userId: string,
  entity: MsEntityType,
  scopeOnMissing: string,
  startMs: number,
  err: unknown,
): SyncWorkerResult {
  const info = describeGraphError(err);
  const durationMs = Date.now() - startMs;
  const base: SyncWorkerResult = {
    entityType: entity,
    created: 0,
    updated: 0,
    deleted: 0,
    durationMs,
    errorMessage: info.message,
  };

  if (info.code === "scope_missing") {
    emitScopeMissing(userId, entity, scopeOnMissing);
    return { ...base, error: "scope_missing" };
  }
  if (info.code === "rate_limited") {
    emitRateLimited(userId, entity, info.retryAfter ?? 0);
    return {
      ...base,
      error: "rate_limited",
      retryAfterSec: info.retryAfter ?? 0,
    };
  }
  if (info.code === "no_token") {
    emitError(userId, entity, "no_token", info.status);
    return { ...base, error: "no_token" };
  }
  if (info.code === "unauthorized") {
    emitError(userId, entity, "unauthorized", info.status);
    return { ...base, error: "unauthorized" };
  }
  if (info.code === "network_error") {
    emitError(userId, entity, "network_error", info.status);
    return { ...base, error: "network_error" };
  }
  // graph_error / not_found / unknown
  emitError(userId, entity, info.code, info.status);
  return { ...base, error: info.code === "unknown" ? "unknown" : "graph_error" };
}

// Re-exported for worker error-handling clarity.
export { GraphClientError };
