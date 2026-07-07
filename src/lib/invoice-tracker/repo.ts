/**
 * Cache repo for the Invoice Trackers — one JSONB snapshot row per tracker.
 * Reads via query(); writes via writeQuery() so a silent failure surfaces as a
 * thrown WriteQueryError (same rule as every other capture path).
 */
import { query, writeQuery } from "@/lib/db";

export interface Snapshot {
  trackerId: string;
  columns: string[];
  rows: Array<Record<string, string>>;
  driveId: string | null;
  itemId: string | null;
  webUrl: string | null;
  sheetName: string | null;
  lastRefreshedAt: string | null;
  lastAttemptedAt: string | null;
  lastAttemptStatus: string | null;
  lastAttemptError: string | null;
}

interface Row {
  tracker_id: string;
  columns: unknown;
  rows: unknown;
  source_drive_id: string | null;
  source_item_id: string | null;
  source_web_url: string | null;
  sheet_name: string | null;
  last_refreshed_at: string | null;
  last_attempted_at: string | null;
  last_attempt_status: string | null;
  last_attempt_error: string | null;
  // Index signature satisfies the pg query helper's generic
  // constraint (T extends Record<string, unknown>).
  [key: string]: unknown;
}

function toSnapshot(r: Row): Snapshot {
  return {
    trackerId: r.tracker_id,
    columns: Array.isArray(r.columns) ? (r.columns as string[]) : [],
    rows: Array.isArray(r.rows) ? (r.rows as Array<Record<string, string>>) : [],
    driveId: r.source_drive_id,
    itemId: r.source_item_id,
    webUrl: r.source_web_url,
    sheetName: r.sheet_name,
    lastRefreshedAt: r.last_refreshed_at,
    lastAttemptedAt: r.last_attempted_at,
    lastAttemptStatus: r.last_attempt_status,
    lastAttemptError: r.last_attempt_error,
  };
}

export async function getSnapshot(trackerId: string): Promise<Snapshot | null> {
  const { rows } = await query<Row>(
    `SELECT tracker_id, columns, rows, source_drive_id, source_item_id,
            source_web_url, sheet_name,
            last_refreshed_at::text AS last_refreshed_at,
            last_attempted_at::text AS last_attempted_at,
            last_attempt_status, last_attempt_error
       FROM instinct_invoice_tracker_cache
      WHERE tracker_id = $1`,
    [trackerId],
  );
  return rows[0] ? toSnapshot(rows[0]) : null;
}

/** Persist a SUCCESSFUL refresh (rows + provenance + timestamps). */
export async function saveSnapshot(input: {
  trackerId: string;
  columns: string[];
  rows: Array<Record<string, string>>;
  driveId: string;
  itemId: string;
  webUrl: string;
  sheetName: string;
}): Promise<void> {
  await writeQuery(
    `INSERT INTO instinct_invoice_tracker_cache
        (tracker_id, columns, rows, source_drive_id, source_item_id,
         source_web_url, sheet_name, last_refreshed_at, last_attempted_at,
         last_attempt_status, last_attempt_error, updated_at)
      VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, $6, $7, NOW(), NOW(), 'succeeded', NULL, NOW())
      ON CONFLICT (tracker_id) DO UPDATE SET
        columns = EXCLUDED.columns,
        rows = EXCLUDED.rows,
        source_drive_id = EXCLUDED.source_drive_id,
        source_item_id = EXCLUDED.source_item_id,
        source_web_url = EXCLUDED.source_web_url,
        sheet_name = EXCLUDED.sheet_name,
        last_refreshed_at = NOW(),
        last_attempted_at = NOW(),
        last_attempt_status = 'succeeded',
        last_attempt_error = NULL,
        updated_at = NOW()`,
    [
      input.trackerId,
      JSON.stringify(input.columns),
      JSON.stringify(input.rows),
      input.driveId,
      input.itemId,
      input.webUrl,
      input.sheetName,
    ],
  );
}

/** Record a FAILED attempt without disturbing the last good snapshot rows. */
export async function recordAttempt(
  trackerId: string,
  status: "failed" | "served_stale",
  error: string,
): Promise<void> {
  await writeQuery(
    `INSERT INTO instinct_invoice_tracker_cache
        (tracker_id, last_attempted_at, last_attempt_status, last_attempt_error, updated_at)
      VALUES ($1, NOW(), $2, $3, NOW())
      ON CONFLICT (tracker_id) DO UPDATE SET
        last_attempted_at = NOW(),
        last_attempt_status = $2,
        last_attempt_error = $3,
        updated_at = NOW()`,
    [trackerId, status, error.slice(0, 500)],
  );
}
