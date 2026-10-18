/**
 * The watcher's memory of terminal outcomes (migration 290). A factory PR whose
 * ci-fix step ended in escalate_human is PARKED at its head commit, so the next
 * tick does not ask the model the same question again. Found from the Azure bill:
 * without this, eight stuck PRs were re-authored every 10 minutes for ten days.
 *
 * A park is keyed to the head SHA, so it lifts itself: a new commit on the PR is a
 * new question and the watcher drives it again. Workspace-scoped like every
 * factory table.
 */
import { query } from "@/lib/db";

export const PARK_SQL = `INSERT INTO instinct_ai_code_watch_parked (workspace_id, repo, pr_number, head_sha, action, reason, parked_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (workspace_id, repo, pr_number)
     DO UPDATE SET head_sha = EXCLUDED.head_sha, action = EXCLUDED.action, reason = EXCLUDED.reason, parked_at = now()`;
export const IS_PARKED_SQL = `SELECT 1 FROM instinct_ai_code_watch_parked
      WHERE workspace_id = $1 AND repo = $2 AND pr_number = $3 AND head_sha = $4`;

/** True when this PR is parked at this exact head commit. A read error counts as
 *  parked: skipping one tick is cheap, re-authoring blind is what cost money. */
export async function isParked(workspaceId: string, repo: string, prNumber: number, headSha: string): Promise<boolean> {
  try {
    const r = await query(IS_PARKED_SQL, [workspaceId, repo, prNumber, headSha]);
    return r.rows.length > 0;
  } catch {
    return true;
  }
}

export async function parkPr(workspaceId: string, repo: string, prNumber: number, headSha: string, action: string, reason: string | undefined): Promise<void> {
  await query(PARK_SQL, [workspaceId, repo, prNumber, headSha, action, reason ?? null]);
}
