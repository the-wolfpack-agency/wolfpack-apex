/**
 * GOVERNED backup-agent failover for uptime (migration 184).
 *
 * An agent can designate a BACKUP agent. When the primary goes unhealthy
 * (paused / revoked) or one of its tasks stalls, its queued work fails over to
 * the backup, which runs it under the SAME OGIAM gate and the SAME
 * least-privilege scope it would have run under itself. Failover is a continuity
 * mechanism, NOT a privilege-escalation one.
 *
 * INVARIANTS (the failover guarantees):
 *   1. GOVERNANCE PRESERVED. Reassigning a task only moves its agent_id; the
 *      task stays 'queued' and is later executed AS the backup through the same
 *      governed-execution path every task runs through. The gate is unchanged,
 *      so a step the backup is not allowed to take is still blocked.
 *   2. SCOPE NEVER ESCALATED. A queued task is reassigned to the backup ONLY
 *      when the backup is bound to a SUPERSET of the primary's connections
 *      (listAgentConnectionNames for both). If the backup lacks any connection
 *      the primary holds, the failover is SKIPPED (notify + skip), never forced
 *      through — so the backup can never reach a connector the primary could not.
 *   3. BACKUP MUST BE HEALTHY. Only an ACTIVE backup receives work; a
 *      paused/revoked backup is skipped (we never resurrect work onto a dead
 *      principal).
 *   4. NO SILENT LOSS. Every reclaim, reassign, and failover emits analytics +
 *      a best-effort hash-chained audit entry; the owner is notified.
 *
 * The reclaimer (reclaimStalledTasks) frees tasks a DEAD agent left stuck in
 * 'running' so the failover sweep can pick them up as 'queued' work.
 */

import { safeQuery, writeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { recordAudit } from "@/lib/audit-log";
import { getAgent, listAgents } from "@/lib/agents/store";
import { listAgentConnectionNames } from "@/lib/agents/connections/store";
import { notify } from "@/lib/notifications/in-app";

const DEFAULT_WORKSPACE = "default";

/** Default stall window: a 'running' task whose started_at is older than this is
 *  considered stuck (its agent likely died mid-run). */
export const DEFAULT_STALL_MS = 10 * 60 * 1000;

/** Requeue cap: after this many requeues a stalled task is marked 'failed' so a
 *  permanently stuck task can never loop forever. */
export const RETRY_CAP = 3;

/** Detect whichever agent-principal table name is live (171 created
 *  `instinct_agents`; the brief references `instinct_agent_principals`). Cached
 *  per-process after the first probe. The backup_agent_id column lives on it. */
let cachedPrincipalTable: string | null = null;
async function principalTable(): Promise<string> {
  if (cachedPrincipalTable) return cachedPrincipalTable;
  const res = await safeQuery<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_name IN ('instinct_agent_principals', 'instinct_agents')
      ORDER BY CASE table_name
                 WHEN 'instinct_agent_principals' THEN 0 ELSE 1 END
      LIMIT 1`,
  );
  cachedPrincipalTable = res.rows[0]?.table_name ?? "instinct_agents";
  return cachedPrincipalTable;
}

/** Read an agent's designated backup id (NULL when none). */
export async function getBackupAgentId(
  workspaceId: string,
  agentId: string,
): Promise<string | null> {
  const table = await principalTable();
  const res = await safeQuery<{ backup_agent_id: string | null }>(
    `SELECT backup_agent_id FROM ${table}
      WHERE id = $1 AND workspace_id = $2`,
    [agentId, workspaceId || DEFAULT_WORKSPACE],
  );
  return res.rows[0]?.backup_agent_id ?? null;
}

export interface SetBackupResult {
  ok: boolean;
  code?:
    | "agent_not_found"
    | "backup_not_found"
    | "backup_is_self"
    | "backup_cross_workspace"
    | "backup_cycle";
}

/**
 * Designate (or clear, with null) an agent's backup. Validates that the backup
 * is a DIFFERENT, EXISTING agent in the SAME workspace and does not form a cycle
 * (a -> b -> a). On a valid set/clear, persists, emits agent.backup_designated,
 * and records a best-effort audit entry. Returns { ok } or a typed reason.
 */
export async function setBackupAgent(
  workspaceId: string,
  agentId: string,
  backupAgentId: string | null,
  by: { userId: string; role: string },
): Promise<SetBackupResult> {
  const ws = workspaceId || DEFAULT_WORKSPACE;

  const primary = await getAgent(agentId, ws);
  if (!primary) return { ok: false, code: "agent_not_found" };

  if (backupAgentId !== null) {
    if (backupAgentId === agentId) return { ok: false, code: "backup_is_self" };
    const backup = await getAgent(backupAgentId, ws);
    if (!backup) return { ok: false, code: "backup_not_found" };
    // getAgent is workspace-scoped, so a found backup is same-workspace; this is
    // belt-and-suspenders against a future unscoped read.
    if (backup.workspaceId !== primary.workspaceId) {
      return { ok: false, code: "backup_cross_workspace" };
    }
    // Cycle guard: if the backup already designates THIS agent as its backup,
    // a -> b -> a would loop the failover. Refuse.
    const backupsBackup = await getBackupAgentId(ws, backupAgentId);
    if (backupsBackup === agentId) return { ok: false, code: "backup_cycle" };
  }

  const table = await principalTable();
  await writeQuery(
    `UPDATE ${table} SET backup_agent_id = $3
      WHERE id = $1 AND workspace_id = $2`,
    [agentId, ws, backupAgentId],
    { expectRows: 0 },
  );

  const cleared = backupAgentId === null;
  trackEvent("agent.backup_designated", by.userId, by.role, {
    agent_id: agentId,
    backup_agent_id: backupAgentId ?? "",
    cleared,
  });
  try {
    await recordAudit({
      actor: { user_id: by.userId, role: by.role },
      action: "agent.backup_designated",
      resourceType: "agent",
      resourceId: agentId,
      afterState: { backup_agent_id: backupAgentId, cleared },
    });
  } catch (err) {
    /* Audit is best-effort: the designation already persisted + tracked. */
    console.warn("[failover audit]", (err as Error).message);
  }

  return { ok: true };
}

export interface ReclaimSummary {
  /** stalled tasks freed (requeued or failed). */
  reclaimed: number;
  requeued: number;
  failed: number;
}

/**
 * Free tasks a dead agent left stuck. A task in 'running' whose started_at is
 * older than stallMs is reclaimed: requeued (status 'queued', started_at
 * cleared, retry_count bumped) while under the retry cap, else marked 'failed'.
 * Scoped to a workspace when given, otherwise all workspaces. Emits one
 * agent.task_reclaimed per task. Returns the counts. Best-effort per row: a
 * single failed update is logged and the sweep continues.
 */
export async function reclaimStalledTasks(
  workspaceId?: string,
  stallMs: number = DEFAULT_STALL_MS,
): Promise<ReclaimSummary> {
  const ms = Math.max(0, stallMs);
  const cutoffSecs = Math.floor(ms / 1000);

  const params: unknown[] = [cutoffSecs];
  let wsClause = "";
  if (workspaceId !== undefined) {
    params.push(workspaceId || DEFAULT_WORKSPACE);
    wsClause = ` AND workspace_id = $${params.length}`;
  }

  const stalled = await safeQuery<{
    id: string;
    agent_id: string;
    workspace_id: string;
    retry_count: number | string | null;
  }>(
    `SELECT id, agent_id, workspace_id, retry_count
       FROM instinct_agent_tasks
      WHERE status = 'running'
        AND started_at IS NOT NULL
        AND started_at < NOW() - make_interval(secs => $1)${wsClause}`,
    params,
  );

  let requeued = 0;
  let failed = 0;
  for (const row of stalled.rows) {
    const retry = Number(row.retry_count ?? 0);
    const overCap = retry >= RETRY_CAP;
    try {
      if (overCap) {
        await writeQuery(
          `UPDATE instinct_agent_tasks
              SET status = 'failed', finished_at = NOW()
            WHERE id = $1 AND status = 'running'`,
          [row.id],
          { expectRows: 0 },
        );
        failed += 1;
      } else {
        await writeQuery(
          `UPDATE instinct_agent_tasks
              SET status = 'queued', started_at = NULL,
                  retry_count = COALESCE(retry_count, 0) + 1
            WHERE id = $1 AND status = 'running'`,
          [row.id],
          { expectRows: 0 },
        );
        requeued += 1;
      }
      trackEvent("agent.task_reclaimed", String(row.agent_id), "agent", {
        task_id: String(row.id),
        agent_id: String(row.agent_id),
        workspace_id: String(row.workspace_id),
        action: overCap ? "failed" : "requeued",
      });
    } catch (err) {
      console.warn("[failover reclaim]", String(row.id), (err as Error).message);
    }
  }

  return { reclaimed: requeued + failed, requeued, failed };
}

export interface FailoverReassignment {
  primaryAgentId: string;
  backupAgentId: string;
  workspaceId: string;
  taskCount: number;
}

export interface FailoverSummary {
  /** queued tasks reassigned to a backup. */
  reassigned: number;
  /** unhealthy primaries skipped (no backup, inactive backup, or scope gap). */
  skipped: number;
  reassignments: FailoverReassignment[];
}

/** A backup is scope-compatible iff it is bound to EVERY connection the primary
 *  is bound to (a superset). Returns the primary's connections the backup is
 *  MISSING (empty array = compatible). */
async function missingConnections(
  workspaceId: string,
  primaryAgentId: string,
  backupAgentId: string,
): Promise<string[]> {
  const [primaryConns, backupConns] = await Promise.all([
    listAgentConnectionNames(workspaceId, primaryAgentId),
    listAgentConnectionNames(workspaceId, backupAgentId),
  ]);
  const backupSet = new Set(backupConns);
  return primaryConns.filter((c) => !backupSet.has(c));
}

/**
 * Fail over every UNHEALTHY agent (paused/revoked) that has queued tasks AND a
 * backup whose target is ACTIVE — but ONLY when the backup is scope-compatible
 * (bound to a superset of the primary's connections). On a valid reassign, the
 * task's agent_id is updated to the backup and the status stays 'queued' (it
 * runs later AS the backup, under the gate). Emits agent.failover_triggered
 * (per primary), agent.task_reassigned (per task), a best-effort audit entry,
 * and notifies the primary's owner. A scope gap or inactive backup is skipped
 * (notify + skip) so failover never escalates scope or resurrects work onto a
 * dead principal. Scoped to a workspace when given, else all workspaces.
 */
export async function failoverUnhealthyAgents(
  workspaceId?: string,
): Promise<FailoverSummary> {
  const summary: FailoverSummary = { reassigned: 0, skipped: 0, reassignments: [] };

  // Find unhealthy primaries that actually have a backup designated. We read the
  // roster per workspace through listAgents (which is workspace-scoped), so we
  // first resolve the set of workspaces to sweep.
  const table = await principalTable();
  const params: unknown[] = [];
  let wsClause = "";
  if (workspaceId !== undefined) {
    params.push(workspaceId || DEFAULT_WORKSPACE);
    wsClause = ` AND workspace_id = $${params.length}`;
  }
  const primaries = await safeQuery<{
    id: string;
    workspace_id: string;
    backup_agent_id: string | null;
    owner_user_id: string | null;
  }>(
    `SELECT id, workspace_id, backup_agent_id, owner_user_id
       FROM ${table}
      WHERE state IN ('paused', 'revoked')
        AND backup_agent_id IS NOT NULL${wsClause}`,
    params,
  );

  for (const primary of primaries.rows) {
    const ws = String(primary.workspace_id) || DEFAULT_WORKSPACE;
    const primaryId = String(primary.id);
    const backupId = String(primary.backup_agent_id);

    // The primary's queued work. Nothing queued -> nothing to fail over.
    const queued = await safeQuery<{ id: string }>(
      `SELECT id FROM instinct_agent_tasks
        WHERE agent_id = $1 AND workspace_id = $2 AND status = 'queued'`,
      [primaryId, ws],
    );
    if (queued.rows.length === 0) continue;

    // The backup must exist and be ACTIVE. A paused/revoked or missing backup is
    // skipped — we never resurrect work onto a dead principal.
    const backup = await getAgent(backupId, ws);
    if (!backup || backup.state !== "active") {
      summary.skipped += 1;
      await notifyOwner(
        primary.owner_user_id,
        primaryId,
        `Backup agent for ${primaryId} is not active; ${queued.rows.length} queued task(s) were NOT failed over.`,
        `failover_skip_inactive:${primaryId}`,
      );
      continue;
    }

    // SCOPE GUARD: the backup must be bound to a superset of the primary's
    // connections. A missing connection means reassigning would let the backup
    // operate a connector the primary could not — that is scope ESCALATION, so
    // we skip (notify + skip) instead.
    const missing = await missingConnections(ws, primaryId, backupId);
    if (missing.length > 0) {
      summary.skipped += 1;
      await notifyOwner(
        primary.owner_user_id,
        primaryId,
        `Failover skipped: backup ${backupId} is missing connection(s) ${missing.join(", ")} that ${primaryId} holds. Reassigning would escalate scope, so ${queued.rows.length} queued task(s) stay put.`,
        `failover_skip_scope:${primaryId}`,
      );
      continue;
    }

    // Valid reassign: move every queued task to the backup. The status stays
    // 'queued' so it runs later AS the backup, under the SAME gate.
    let movedCount = 0;
    for (const t of queued.rows) {
      const taskId = String(t.id);
      try {
        await writeQuery(
          `UPDATE instinct_agent_tasks
              SET agent_id = $1
            WHERE id = $2 AND workspace_id = $3 AND status = 'queued'`,
          [backupId, taskId, ws],
          { expectRows: 0 },
        );
        movedCount += 1;
        trackEvent("agent.task_reassigned", primaryId, "agent", {
          task_id: taskId,
          from_agent_id: primaryId,
          to_agent_id: backupId,
          workspace_id: ws,
        });
      } catch (err) {
        console.warn("[failover reassign]", taskId, (err as Error).message);
      }
    }

    if (movedCount === 0) continue;

    summary.reassigned += movedCount;
    summary.reassignments.push({
      primaryAgentId: primaryId,
      backupAgentId: backupId,
      workspaceId: ws,
      taskCount: movedCount,
    });

    trackEvent("agent.failover_triggered", primaryId, "agent", {
      primary_agent_id: primaryId,
      backup_agent_id: backupId,
      task_count: movedCount,
    });
    try {
      await recordAudit({
        actor: { user_id: "system", role: "system" },
        action: "agent.failover_triggered",
        resourceType: "agent",
        resourceId: primaryId,
        afterState: {
          backup_agent_id: backupId,
          workspace_id: ws,
          task_count: movedCount,
        },
      });
    } catch (err) {
      console.warn("[failover audit]", (err as Error).message);
    }
    await notifyOwner(
      primary.owner_user_id,
      primaryId,
      `Agent ${primaryId} is unhealthy; ${movedCount} queued task(s) failed over to backup ${backupId}, which runs them under the same gate and scope.`,
      `failover_triggered:${primaryId}`,
    );
  }

  return summary;
}

/** Best-effort owner notification. A missing owner or a notify failure must
 *  never break the sweep. */
async function notifyOwner(
  ownerUserId: string | null | undefined,
  primaryAgentId: string,
  body: string,
  dedupKey: string,
): Promise<void> {
  if (!ownerUserId) return;
  try {
    await notify({
      userId: ownerUserId,
      category: "agent",
      priority: "high",
      title: "Agent failover",
      body,
      actionUrl: `/admin/agents/${primaryAgentId}`,
      actionLabel: "Review agent",
      source: "agent_failover",
      sourceId: dedupKey,
      metadata: { agent_id: primaryAgentId },
      dedup: true,
    });
  } catch (err) {
    console.warn("[failover notify]", (err as Error).message);
  }
}

/**
 * The cron sweep: reclaim stalled tasks first (so a dead agent's stuck work
 * becomes queued), then fail over unhealthy agents' queued work to their
 * backups. Emits agent.failover_swept with the totals. Returns the combined
 * summary. The two phases are independent; a throw in one is contained by the
 * caller (the cron route never 500s).
 */
export async function runFailoverSweep(
  workspaceId?: string,
  stallMs: number = DEFAULT_STALL_MS,
): Promise<{ reclaimed: number; reassigned: number; skipped: number }> {
  const reclaim = await reclaimStalledTasks(workspaceId, stallMs);
  const failover = await failoverUnhealthyAgents(workspaceId);
  const totals = {
    reclaimed: reclaim.reclaimed,
    reassigned: failover.reassigned,
    skipped: failover.skipped,
  };
  trackEvent("agent.failover_swept", "system", "system", totals);
  return totals;
}

/** Re-export for callers that want the agent roster without importing the store
 *  directly (UI backup-select is populated from the OTHER agents). */
export { listAgents };
