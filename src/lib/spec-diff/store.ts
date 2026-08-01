/**
 * Persistence for spec-diff runs (migration 225).
 *
 * Every query filters on workspace_id explicitly: this table is tenant scoped
 * and the repo-wide tenant-isolation scan requires the predicate to be visible
 * here, not implied by a caller.
 */
import { query } from "@/lib/db";
import type { SpecDiffRun } from "./run";

export interface StoredSpecDiffRun extends Record<string, unknown> {
  id: string;
  spec_url: string;
  target_url: string;
  viewports: { width: number; height: number }[];
  tolerance_px: number;
  clean: boolean;
  total_diffs: number;
  total_missing: number;
  font_mismatch: boolean;
  matched_elements: number;
  results: unknown;
  errors: unknown;
  duration_ms: number;
  created_by: string | null;
  created_at: string;
}

/** Record a completed run. Returns the stored row's id. */
export async function saveSpecDiffRun(
  workspaceId: string,
  run: SpecDiffRun,
  meta: { viewports: { width: number; height: number }[]; durationMs: number; createdBy?: string | null },
): Promise<string> {
  const res = await query<{ id: string }>(
    `INSERT INTO instinct_spec_diff_runs
       (workspace_id, spec_url, target_url, viewports, tolerance_px, clean, total_diffs,
        total_missing, font_mismatch, matched_elements, results, errors, duration_ms, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14)
     RETURNING id::text AS id`,
    [
      workspaceId,
      run.specUrl,
      run.targetUrl,
      JSON.stringify(meta.viewports),
      run.tolerancePx,
      run.summary.clean,
      run.summary.totalDiffs,
      run.summary.totalMissing,
      run.summary.fontMismatch,
      run.summary.matchedElements,
      JSON.stringify(run.results),
      JSON.stringify(run.errors),
      Math.max(0, Math.round(meta.durationMs)),
      meta.createdBy ?? null,
    ],
  );
  return res.rows[0]?.id ?? "";
}

/** One workspace's recent runs, newest first. */
export async function listSpecDiffRuns(workspaceId: string, limit = 25): Promise<StoredSpecDiffRun[]> {
  const res = await query<StoredSpecDiffRun>(
    `SELECT id::text AS id, spec_url, target_url, viewports, tolerance_px, clean, total_diffs,
            total_missing, font_mismatch, matched_elements, results, errors, duration_ms,
            created_by, created_at
       FROM instinct_spec_diff_runs
      WHERE workspace_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [workspaceId, Math.min(Math.max(1, limit), 100)],
  );
  return res.rows;
}

/**
 * How one converted page has trended: is it getting closer to its prototype, or
 * drifting away as the implementation changes.
 */
export async function specDiffTrend(workspaceId: string, targetUrl: string, limit = 20): Promise<Pick<StoredSpecDiffRun, "id" | "total_diffs" | "font_mismatch" | "clean" | "created_at">[]> {
  const res = await query<StoredSpecDiffRun>(
    `SELECT id::text AS id, total_diffs, font_mismatch, clean, created_at
       FROM instinct_spec_diff_runs
      WHERE workspace_id = $1 AND target_url = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [workspaceId, targetUrl, Math.min(Math.max(1, limit), 100)],
  );
  return res.rows;
}
