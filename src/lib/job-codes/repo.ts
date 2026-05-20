/**
 * Postgres persistence for the job-codes cache.
 *
 * Every write goes through `writeQuery` so the silent-data-loss bug
 * class (CTO directive 2026-04-19) can't recur — a refresh that drops
 * 30 rows but says "succeeded" would fail the row-count assertion.
 */

import { query, writeQuery } from "@/lib/db";
import type {
  JobCode,
  JobCodesRefreshOutcome,
  JobCodesRefreshSource,
  JobCodesRefreshStatus,
  JobCodesSourceInfo,
} from "./types";

interface CacheRow {
  code: string;
  description: string;
  sheet_name: string;
  active: boolean;
  last_seen_at: string;
  source_drive_id: string | null;
  source_item_id: string | null;
  source_web_url: string | null;
  // Index signature satisfies the pg query helper's generic
  // constraint (T extends Record<string, unknown>).
  [key: string]: unknown;
}

interface RefreshRow {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: JobCodesRefreshStatus;
  source: JobCodesRefreshSource;
  rows_seen: number;
  rows_added: number;
  rows_updated: number;
  rows_deactivated: number;
  error_code: string | null;
  error_detail: string | null;
  [key: string]: unknown;
}

function rowToCode(r: CacheRow): JobCode {
  return {
    code: r.code,
    description: r.description ?? "",
    sheetName: r.sheet_name ?? "",
    active: !!r.active,
    lastSeenAt: r.last_seen_at,
  };
}

/** All ACTIVE codes, ordered alphabetically. The TimeLogWidget +
 *  /job-codes page both use this view. */
export async function listActiveJobCodes(): Promise<JobCode[]> {
  const res = await query<CacheRow>(
    `SELECT code, description, sheet_name, active, last_seen_at,
            source_drive_id, source_item_id, source_web_url
     FROM instinct_job_codes_cache
     WHERE active = TRUE
     ORDER BY code ASC`,
  );
  return res.rows.map(rowToCode);
}

/** Includes inactive (historical) codes — used by the admin/audit
 *  view. The dropdown should never call this. */
export async function listAllJobCodes(): Promise<JobCode[]> {
  const res = await query<CacheRow>(
    `SELECT code, description, sheet_name, active, last_seen_at,
            source_drive_id, source_item_id, source_web_url
     FROM instinct_job_codes_cache
     ORDER BY active DESC, code ASC`,
  );
  return res.rows.map(rowToCode);
}

/**
 * Atomically replace the cache with the given live rows.
 *
 * The contract is "UPSERT then deactivate-missing":
 *   - Each row in `rows` gets UPSERTed by lowercased code, stamping
 *     last_seen_at = NOW().
 *   - Any cache row whose last_seen_at is older than the batch's
 *     start is marked active=false (it disappeared from the workbook).
 *
 * Returns add/update/deactivate counts so the refresh log row can
 * surface meaningful "what changed" numbers.
 */
export async function replaceJobCodes(
  rows: JobCode[],
  source: { driveId: string; itemId: string; webUrl: string },
): Promise<{ added: number; updated: number; deactivated: number }> {
  const batchStart = new Date().toISOString();

  // Snapshot pre-state so we can compute the diff after the UPSERT.
  const beforeRes = await query<{ code: string }>(
    `SELECT code FROM instinct_job_codes_cache`,
  );
  const beforeCodes = new Set(beforeRes.rows.map((r) => r.code.toLowerCase()));

  // UPSERT each row. We do this in a single query via UNNEST so the
  // whole refresh is one round-trip + one row-count assertion.
  if (rows.length > 0) {
    const codes = rows.map((r) => r.code);
    const descs = rows.map((r) => r.description ?? "");
    const sheets = rows.map((r) => r.sheetName ?? "");
    await writeQuery(
      `INSERT INTO instinct_job_codes_cache
         (code, description, sheet_name, active, last_seen_at,
          source_drive_id, source_item_id, source_web_url, updated_at)
       SELECT
         c, d, s, TRUE, NOW(),
         $4, $5, $6, NOW()
       FROM unnest($1::text[], $2::text[], $3::text[]) AS x(c, d, s)
       ON CONFLICT (LOWER(code))
       DO UPDATE SET
         description = EXCLUDED.description,
         sheet_name = EXCLUDED.sheet_name,
         active = TRUE,
         last_seen_at = NOW(),
         source_drive_id = EXCLUDED.source_drive_id,
         source_item_id = EXCLUDED.source_item_id,
         source_web_url = EXCLUDED.source_web_url,
         updated_at = NOW()`,
      [codes, descs, sheets, source.driveId, source.itemId, source.webUrl],
    );
  }

  // Deactivate codes the workbook no longer contains.
  const deact = await writeQuery<{ code: string }>(
    `UPDATE instinct_job_codes_cache
     SET active = FALSE, updated_at = NOW()
     WHERE active = TRUE AND last_seen_at < $1
     RETURNING code`,
    [batchStart],
  );

  let added = 0;
  let updated = 0;
  for (const r of rows) {
    if (beforeCodes.has(r.code.toLowerCase())) updated++;
    else added++;
  }

  return {
    added,
    updated,
    deactivated: deact.rows.length,
  };
}

/**
 * Read the last-known source pointers and freshness info, joining the
 * cache table with the most recent refresh attempt.
 */
export async function getSourceInfo(): Promise<JobCodesSourceInfo> {
  const c = await query<{
    source_drive_id: string | null;
    source_item_id: string | null;
    source_web_url: string | null;
    sheet_name: string | null;
  }>(
    `SELECT source_drive_id, source_item_id, source_web_url, sheet_name
     FROM instinct_job_codes_cache
     WHERE active = TRUE
     ORDER BY last_seen_at DESC LIMIT 1`,
  );
  const cacheRow = c.rows[0] ?? null;

  const r = await query<{
    started_at: string;
    finished_at: string | null;
    status: JobCodesRefreshStatus;
    error_code: string | null;
    error_detail: string | null;
  }>(
    `SELECT started_at, finished_at, status, error_code, error_detail
     FROM instinct_job_codes_refresh
     ORDER BY started_at DESC LIMIT 1`,
  );
  const lastAttempt = r.rows[0] ?? null;

  const lastSuccess = await query<{ finished_at: string | null }>(
    `SELECT finished_at FROM instinct_job_codes_refresh
     WHERE status = 'succeeded'
     ORDER BY started_at DESC LIMIT 1`,
  );

  return {
    driveId: cacheRow?.source_drive_id ?? null,
    itemId: cacheRow?.source_item_id ?? null,
    webUrl: cacheRow?.source_web_url ?? null,
    sheetName: cacheRow?.sheet_name ?? null,
    lastRefreshedAt: lastSuccess.rows[0]?.finished_at ?? null,
    lastAttemptedAt: lastAttempt?.started_at ?? null,
    lastAttemptStatus: lastAttempt?.status ?? null,
    lastAttemptError: lastAttempt?.error_detail ?? null,
  };
}

/**
 * Record a refresh attempt. Called twice per attempt (once to claim
 * with status='running', once to finalize) — but for simplicity v1
 * inserts a single completed row after the attempt resolves.
 */
export async function recordRefreshOutcome(
  outcome: JobCodesRefreshOutcome,
  triggeredBy: string | null,
): Promise<RefreshRow> {
  const res = await writeQuery<RefreshRow>(
    `INSERT INTO instinct_job_codes_refresh
       (started_at, finished_at, status, source, triggered_by,
        rows_seen, rows_added, rows_updated, rows_deactivated,
        error_code, error_detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      outcome.startedAt,
      outcome.finishedAt,
      outcome.status,
      outcome.source,
      triggeredBy,
      outcome.rowsSeen,
      outcome.rowsAdded,
      outcome.rowsUpdated,
      outcome.rowsDeactivated,
      outcome.error?.code ?? null,
      outcome.error?.detail ?? null,
    ],
    { expectRows: 1 },
  );
  return res.rows[0];
}
