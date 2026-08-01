/**
 * Persistence for site acceptance (migration 226).
 *
 * Every query filters on workspace_id explicitly. The repo-wide tenant-isolation
 * scan requires the predicate to be visible HERE rather than implied by whoever
 * calls it, and a criteria row that leaked across workspaces would let one
 * tenant's contract judge another tenant's build.
 */
import { query } from "@/lib/db";
import { parseCriteria, criteriaCompleteness, type AcceptanceCriteria } from "./criteria";
import type { AcceptanceVerdict } from "./evaluate";

export type AcceptanceRunStatus = "queued" | "running" | "passed" | "failed" | "degraded";

export interface StoredAcceptance extends Record<string, unknown> {
  project_id: string;
  prototype_url: string | null;
  criteria: AcceptanceCriteria;
  completeness: number;
  updated_by: string | null;
  updated_at: string;
}

export interface StoredAcceptanceRun extends Record<string, unknown> {
  id: string;
  project_id: string;
  deploy_id: string;
  deployed_url: string | null;
  status: AcceptanceRunStatus;
  verdict: AcceptanceVerdict | null;
  spec_diff_run_id: string | null;
  attempts: number;
  last_error: string | null;
  duration_ms: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/* ------------------------------ criteria ------------------------------ */

/**
 * The contract for one project. Returns null when none was ever saved, which the
 * caller must distinguish from "saved with defaults": an intake that skipped the
 * form is a different data point from one that accepted the defaults on purpose.
 */
export async function getAcceptanceCriteria(workspaceId: string, projectId: string): Promise<StoredAcceptance | null> {
  const res = await query<StoredAcceptance>(
    `SELECT project_id, prototype_url, criteria, completeness::float8 AS completeness, updated_by, updated_at
       FROM instinct_site_acceptance
      WHERE workspace_id = $1 AND project_id = $2`,
    [workspaceId, projectId],
  );
  const row = res.rows[0];
  if (!row) return null;
  // Re-parse on read: a row written before a field existed still comes back as a
  // complete, valid contract rather than a partial object the evaluator would
  // have to guess about.
  return { ...row, criteria: parseCriteria(row.criteria) };
}

/** Insert or replace the contract. Validation happens in parseCriteria, above
 *  this layer, so an invalid criterion never reaches the database. */
export async function saveAcceptanceCriteria(
  workspaceId: string,
  projectId: string,
  criteria: AcceptanceCriteria,
  updatedBy: string | null,
): Promise<StoredAcceptance> {
  const res = await query<StoredAcceptance>(
    `INSERT INTO instinct_site_acceptance
       (project_id, workspace_id, prototype_url, criteria, completeness, updated_by, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, NOW())
     ON CONFLICT (project_id) DO UPDATE
        SET prototype_url = EXCLUDED.prototype_url,
            criteria      = EXCLUDED.criteria,
            completeness  = EXCLUDED.completeness,
            updated_by    = EXCLUDED.updated_by,
            updated_at    = NOW()
      WHERE instinct_site_acceptance.workspace_id = $2
     RETURNING project_id, prototype_url, criteria, completeness::float8 AS completeness, updated_by, updated_at`,
    [projectId, workspaceId, criteria.prototypeUrl, JSON.stringify(criteria), criteriaCompleteness(criteria), updatedBy],
  );
  const row = res.rows[0];
  return { ...row, criteria: parseCriteria(row.criteria) };
}

/**
 * Which workspace's contract governs this project.
 *
 * The Sites module is not workspace-scoped (one project row, no workspace
 * column), but acceptance is: a contract belongs to whoever wrote it. The deploy
 * webhook is a server-to-server call with no user, so it resolves the workspace
 * from the criteria row rather than assuming one. Falling back to 'default'
 * matches what the API routes use when a user has no workspace claim, so a
 * project whose criteria were saved by such a user still lines up.
 */
export async function resolveAcceptanceWorkspace(projectId: string): Promise<string> {
  const res = await query<{ workspace_id: string }>(
    `SELECT workspace_id FROM instinct_site_acceptance WHERE project_id = $1`,
    [projectId],
  );
  return res.rows[0]?.workspace_id ?? "default";
}

/* -------------------------------- runs -------------------------------- */

/**
 * Record that a deploy is waiting to be judged. Called the moment a deploy
 * succeeds, before any checking happens, so an attempt that never runs is
 * visible as queued rather than missing.
 *
 * Idempotent per deploy: the unique index means a replayed webhook updates the
 * URL instead of creating a second row a drain would then run twice.
 */
export async function enqueueAcceptanceRun(
  workspaceId: string,
  projectId: string,
  deployId: string,
  deployedUrl: string | null,
): Promise<string> {
  const res = await query<{ id: string }>(
    `INSERT INTO instinct_site_acceptance_runs (workspace_id, project_id, deploy_id, deployed_url, status)
     VALUES ($1, $2, $3, $4, 'queued')
     ON CONFLICT (deploy_id) DO UPDATE
        SET deployed_url = COALESCE(EXCLUDED.deployed_url, instinct_site_acceptance_runs.deployed_url)
      WHERE instinct_site_acceptance_runs.workspace_id = $1
     RETURNING id::text AS id`,
    [workspaceId, projectId, deployId, deployedUrl],
  );
  return res.rows[0]?.id ?? "";
}

/**
 * Claim the oldest queued run, atomically, so two drains running at once cannot
 * both take the same work. A run stuck in `running` past `staleAfterMinutes` is
 * reclaimable: a serverless function can vanish mid-run, and a permanently
 * stuck row is indistinguishable from a check nobody ever performed.
 */
export async function claimNextAcceptanceRun(staleAfterMinutes = 15): Promise<StoredAcceptanceRun | null> {
  const res = await query<StoredAcceptanceRun & { workspace_id: string }>(
    `UPDATE instinct_site_acceptance_runs
        SET status = 'running', started_at = NOW(), attempts = attempts + 1
      WHERE id = (
        SELECT id FROM instinct_site_acceptance_runs
         WHERE status = 'queued'
            OR (status = 'running' AND started_at < NOW() - ($1 || ' minutes')::interval)
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
     RETURNING id::text AS id, workspace_id, project_id, deploy_id, deployed_url, status,
               verdict, spec_diff_run_id::text AS spec_diff_run_id, attempts, last_error,
               duration_ms, created_at, started_at, finished_at`,
    [String(Math.max(1, staleAfterMinutes))],
  );
  return res.rows[0] ?? null;
}

/** Write the terminal state of one run. */
export async function completeAcceptanceRun(
  workspaceId: string,
  runId: string,
  result: {
    status: AcceptanceRunStatus;
    verdict?: AcceptanceVerdict | null;
    specDiffRunId?: string | null;
    lastError?: string | null;
    durationMs?: number;
  },
): Promise<void> {
  await query(
    `UPDATE instinct_site_acceptance_runs
        SET status = $3,
            verdict = $4::jsonb,
            spec_diff_run_id = $5,
            last_error = $6,
            duration_ms = $7,
            finished_at = NOW()
      WHERE workspace_id = $1 AND id = $2`,
    [
      workspaceId,
      runId,
      result.status,
      result.verdict ? JSON.stringify(result.verdict) : null,
      result.specDiffRunId ?? null,
      result.lastError ?? null,
      result.durationMs == null ? null : Math.max(0, Math.round(result.durationMs)),
    ],
  );
}

/** One project's attempts, newest first. */
export async function listAcceptanceRuns(workspaceId: string, projectId: string, limit = 25): Promise<StoredAcceptanceRun[]> {
  const res = await query<StoredAcceptanceRun>(
    `SELECT id::text AS id, project_id, deploy_id, deployed_url, status, verdict,
            spec_diff_run_id::text AS spec_diff_run_id, attempts, last_error, duration_ms,
            created_at, started_at, finished_at
       FROM instinct_site_acceptance_runs
      WHERE workspace_id = $1 AND project_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [workspaceId, projectId, Math.min(Math.max(1, limit), 100)],
  );
  return res.rows;
}

/**
 * The learning question this layer exists to answer: does a more completely
 * specified intake produce a build that is right the first time? Grouped by how
 * much of the contract was filled in, so the answer is a comparison and not an
 * average.
 */
export async function acceptanceOutcomeByCompleteness(
  workspaceId: string,
): Promise<{ completeness_band: string; runs: number; passed: number; failed: number; degraded: number }[]> {
  const res = await query<{ completeness_band: string; runs: string; passed: string; failed: string; degraded: string }>(
    `SELECT CASE
              WHEN a.completeness >= 0.8 THEN 'high'
              WHEN a.completeness >= 0.4 THEN 'medium'
              ELSE 'low'
            END AS completeness_band,
            COUNT(*)::text AS runs,
            COUNT(*) FILTER (WHERE r.status = 'passed')::text AS passed,
            COUNT(*) FILTER (WHERE r.status = 'failed')::text AS failed,
            COUNT(*) FILTER (WHERE r.status = 'degraded')::text AS degraded
       FROM instinct_site_acceptance_runs r
       JOIN instinct_site_acceptance a
         ON a.project_id = r.project_id AND a.workspace_id = r.workspace_id
      WHERE r.workspace_id = $1
        AND r.status IN ('passed', 'failed', 'degraded')
      GROUP BY 1
      ORDER BY 1`,
    [workspaceId],
  );
  return res.rows.map((r) => ({
    completeness_band: r.completeness_band,
    runs: Number(r.runs),
    passed: Number(r.passed),
    failed: Number(r.failed),
    degraded: Number(r.degraded),
  }));
}
