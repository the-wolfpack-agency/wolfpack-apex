/**
 * Repo baseline snapshot store (migration 273).
 *
 * Persists a client repo's CI check state at a point in time (typically at
 * connect, "before testing") so pre-existing failures are documented up front.
 * One row per (workspace_id, repo): saving re-baselines (an intentional new
 * known-good starting point). Workspace-scoped reads. Never leaks across tenants.
 */
import { writeQuery, safeQuery } from "@/lib/db";
import { summarizeChecks } from "./ci-status";
import type { CheckRun } from "@/lib/github-client";

export interface RepoBaseline {
  repo: string;
  defaultBranch: string | null;
  totalCount: number;
  failingCount: number;
  failingChecks: string[];
  checks: CheckRun[];
  capturedAt: string;
}

/** Capture (upsert) a baseline from a repo's current check runs. Returns the
 *  summary counts that were stored. */
export async function saveRepoBaseline(args: {
  workspaceId: string;
  repo: string;
  defaultBranch: string | null;
  checks: readonly CheckRun[];
  capturedBy: string;
}): Promise<{ totalCount: number; failingCount: number; failingChecks: string[] }> {
  const s = summarizeChecks(args.checks);
  await writeQuery(
    `INSERT INTO instinct_repo_baseline
       (workspace_id, repo, default_branch, checks, total_count, failing_count, failing_checks, captured_by, captured_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, now())
     ON CONFLICT (workspace_id, repo)
       DO UPDATE SET default_branch = EXCLUDED.default_branch,
                     checks = EXCLUDED.checks,
                     total_count = EXCLUDED.total_count,
                     failing_count = EXCLUDED.failing_count,
                     failing_checks = EXCLUDED.failing_checks,
                     captured_by = EXCLUDED.captured_by,
                     captured_at = now()`,
    [
      args.workspaceId,
      args.repo,
      args.defaultBranch,
      JSON.stringify(args.checks),
      s.total,
      s.failed,
      s.failedChecks,
      args.capturedBy,
    ],
  );
  return { totalCount: s.total, failingCount: s.failed, failingChecks: s.failedChecks };
}

/** Read the stored baseline for a repo, or null when none was captured. */
export async function getRepoBaseline(workspaceId: string, repo: string): Promise<RepoBaseline | null> {
  const { rows } = await safeQuery<{
    repo: string;
    default_branch: string | null;
    total_count: number;
    failing_count: number;
    failing_checks: string[];
    checks: CheckRun[];
    captured_at: string;
  }>(
    `SELECT repo, default_branch, total_count, failing_count, failing_checks, checks, captured_at::text AS captured_at
       FROM instinct_repo_baseline WHERE workspace_id = $1 AND repo = $2`,
    [workspaceId, repo],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    repo: r.repo,
    defaultBranch: r.default_branch,
    totalCount: Number(r.total_count),
    failingCount: Number(r.failing_count),
    failingChecks: r.failing_checks ?? [],
    checks: Array.isArray(r.checks) ? r.checks : [],
    capturedAt: r.captured_at,
  };
}
