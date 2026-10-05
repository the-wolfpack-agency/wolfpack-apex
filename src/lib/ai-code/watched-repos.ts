/**
 * The autonomous watcher's enrolled repos, per WORKSPACE - SaaS config in the DB,
 * not per-project env vars. A client enrolls a repo once (UI/API) and one
 * deployment serves every workspace. The cron reads every enabled row across all
 * workspaces and drives each with that workspace's own credentials + entitlement.
 *
 * Reads use safeQuery (never throw - a DB hiccup yields [] so the cron degrades to
 * "watch nothing", never crashes). Writes use query so the API surfaces failures.
 */
import { query, safeQuery } from "@/lib/db";

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** True when a string is a well-formed owner/name repo. Pure. */
export function isValidRepo(repo: string): boolean {
  return REPO_RE.test(repo);
}

export interface WatchedRepo {
  repo: string;
  enabled: boolean;
  createdAt: string;
}

/** The repos a workspace has enrolled, newest first. Never throws. */
export async function listWatchedRepos(workspaceId: string): Promise<WatchedRepo[]> {
  const { rows } = await safeQuery<{ repo: string; enabled: boolean; created_at: string }>(
    `SELECT repo, enabled, created_at::text AS created_at
       FROM instinct_ai_code_watched_repos
      WHERE workspace_id = $1
      ORDER BY created_at DESC`,
    [workspaceId],
  );
  return rows.map((r) => ({ repo: r.repo, enabled: r.enabled, createdAt: r.created_at }));
}

/** Every ENABLED (workspace, repo) across ALL workspaces - the cron's work list.
 *  Never throws (safeQuery): a read failure yields [], so the watcher does nothing
 *  rather than crashing the cron. */
export async function listAllEnabledWatched(): Promise<Array<{ workspaceId: string; repo: string }>> {
  const { rows } = await safeQuery<{ workspace_id: string; repo: string }>(
    `SELECT workspace_id, repo
       FROM instinct_ai_code_watched_repos
      WHERE enabled = TRUE
      ORDER BY workspace_id, repo`,
  );
  return rows.map((r) => ({ workspaceId: r.workspace_id, repo: r.repo }));
}

/** Enroll (or re-enable) a repo for a workspace. Idempotent upsert. Throws on an
 *  invalid repo shape so the API returns 400. */
export async function enrollRepo(workspaceId: string, repo: string): Promise<void> {
  if (!isValidRepo(repo)) throw new Error("repo must be in owner/name form");
  await query(
    `INSERT INTO instinct_ai_code_watched_repos (workspace_id, repo, enabled)
     VALUES ($1, $2, TRUE)
     ON CONFLICT (workspace_id, repo)
     DO UPDATE SET enabled = TRUE, updated_at = NOW()`,
    [workspaceId, repo],
  );
}

/** Pause or resume a repo without un-enrolling it. */
export async function setRepoEnabled(workspaceId: string, repo: string, enabled: boolean): Promise<void> {
  await query(
    `UPDATE instinct_ai_code_watched_repos
        SET enabled = $3, updated_at = NOW()
      WHERE workspace_id = $1 AND repo = $2`,
    [workspaceId, repo, enabled],
  );
}

/** Remove a repo from a workspace's watch list entirely. */
export async function unenrollRepo(workspaceId: string, repo: string): Promise<void> {
  await query(
    `DELETE FROM instinct_ai_code_watched_repos WHERE workspace_id = $1 AND repo = $2`,
    [workspaceId, repo],
  );
}

/** Our own repo - always self-watched so the factory maintains itself without a
 *  new env var. Eligibility of individual PRs is still gated by entitlement + the
 *  factory-branch / ci-autofix-label rule. */
export const SELF_REPO = "the-wolfpack-agency/wolfpack-apex";

/** Merge the DB-enrolled targets with the env bootstrap fallback, deduped by
 *  (workspace, repo). The env (AI_CODE_WATCH_REPOS + AI_CODE_WATCH_WORKSPACE) is a
 *  single-tenant convenience only; the DB is the SaaS source of truth. Pure over
 *  its inputs so it is testable without a DB. */
export function mergeWatchTargets(
  dbTargets: ReadonlyArray<{ workspaceId: string; repo: string }>,
  envRepos: string | undefined,
  envWorkspace: string | undefined,
): Array<{ workspaceId: string; repo: string }> {
  const seen = new Set<string>();
  const out: Array<{ workspaceId: string; repo: string }> = [];
  const add = (workspaceId: string, repo: string) => {
    if (!isValidRepo(repo)) return;
    const key = `${workspaceId} ${repo}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ workspaceId, repo });
  };
  for (const t of dbTargets) add(t.workspaceId, t.repo);
  const ws = envWorkspace && envWorkspace.trim() ? envWorkspace.trim() : "default";
  for (const r of (envRepos ?? "").split(",").map((s) => s.trim()).filter(Boolean)) add(ws, r);
  // Always watch OUR OWN repo (self-maintaining), with NO new required env var.
  // This only makes the cron LIST apex's PRs; which ones it may act on is still
  // gated downstream by the secure_agent entitlement check + the watcher's
  // factory-branch / ci-autofix-label rule, so an unlabeled human PR is untouched.
  add(ws, SELF_REPO);
  return out;
}
