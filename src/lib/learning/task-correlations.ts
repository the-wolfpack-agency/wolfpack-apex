/**
 * Cross-module helpers — correlate Microsoft 365 Tasks with other modules
 * (meetings, HR, journal) via the local cache.
 *
 * The assistant / daily briefing calls `getRecentTasksForContext` to pull
 * the user's recent task state as additional context. We keep this in the
 * `learning/` namespace so it can grow into a proper correlation engine
 * (e.g. "tasks mentioned in today's meetings", "open HR tasks older than
 * 7 days") without reshaping the integration module.
 *
 * TODO(Assistant integration): wire into the assistant RAG pipeline once
 * the meetings/journal retrieval hooks accept an injected context slice.
 */

import { safeQuery } from "@/lib/db";
import type { MsTask, TaskStatus } from "@/lib/integrations/microsoft-tasks";

export interface RecentTasksOpts {
  /** Look back window in hours. Defaults to 168h (7d). */
  windowHours?: number;
  /** Max tasks to return. Defaults to 25. */
  limit?: number;
  /** Restrict to these statuses. Defaults to [notStarted, inProgress, waitingOnOthers]. */
  statuses?: TaskStatus[];
}

/**
 * Return the caller's recently-updated or due tasks for injection into
 * assistant / briefing context. Reads are served entirely from cache.
 */
export async function getRecentTasksForContext(
  userId: string,
  opts: RecentTasksOpts = {},
): Promise<MsTask[]> {
  const windowHours = Math.max(1, opts.windowHours ?? 168);
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const statuses = opts.statuses ?? ["notStarted", "inProgress", "waitingOnOthers"];

  const { rows } = await safeQuery<any>(  
    `SELECT t.*, l.ms_list_id AS list_ms_id
     FROM instinct_tasks t
     JOIN instinct_task_lists l ON l.id = t.list_id
     WHERE t.user_id = $1
       AND t.status = ANY($2::text[])
       AND (
         t.updated_at >= NOW() - (INTERVAL '1 hour' * $3)
         OR (t.due_at IS NOT NULL AND t.due_at <= NOW() + (INTERVAL '1 hour' * $3))
       )
     ORDER BY
       CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END,
       t.due_at ASC,
       t.updated_at DESC
     LIMIT $4`,
    [userId, statuses, windowHours, limit],
  );

  return rows.map((r) => ({
    id: r.id,
    msTaskId: r.ms_task_id,
    userId: r.user_id,
    listId: r.list_id,
    title: r.title,
    body: r.body,
    status: r.status,
    importance: r.importance,
    dueAt: r.due_at ? new Date(r.due_at).toISOString() : null,
    completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    etag: r.etag,
    syncedAt: new Date(r.synced_at).toISOString(),
    payload: typeof r.payload === "string" ? JSON.parse(r.payload) : (r.payload ?? {}),
  }));
}

/**
 * Short plaintext summary for the daily briefing / assistant preamble.
 */
export async function summarizeRecentTasks(userId: string, opts: RecentTasksOpts = {}): Promise<string> {
  const tasks = await getRecentTasksForContext(userId, opts);
  if (tasks.length === 0) return "No open Microsoft tasks in the window.";
  const lines = tasks.slice(0, 10).map((t) => {
    const due = t.dueAt ? ` (due ${new Date(t.dueAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })})` : "";
    return `- [${t.status}] ${t.title}${due}`;
  });
  return lines.join("\n");
}
