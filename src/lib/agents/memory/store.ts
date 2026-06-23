/**
 * Shared agent procedural memory store (migration 174).
 *
 * recordLearnedProcedure captures a succeeded task's plan as a candidate, then
 * runs the promotion safety check and either promotes it (inheritable) or
 * rejects it (quarantined with a reason). findPromotedProcedure is the
 * inheritance path: a later agent facing the same goal reuses the stored plan
 * and the hit is counted, which is the cost-plateau signal.
 */

import { createHash } from "crypto";
import { query, writeQuery, safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { verifyProcedureForPromotion } from "./promote";
import type { MemoryEntry, MemoryStatus, ProcedureStep } from "./types";

/** Normalize a goal so trivially different phrasings share a key. */
export function normalizeGoalKey(goal: string): string {
  const norm = (goal ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(norm).digest("hex");
}

function mapRow(r: Record<string, unknown>): MemoryEntry {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    goalKey: String(r.goal_key),
    goal: String(r.goal),
    plan: (r.plan as ProcedureStep[] | null) ?? [],
    status: String(r.status) as MemoryStatus,
    learnedByAgent: String(r.learned_by_agent),
    sourceTaskId: (r.source_task_id as string | null) ?? null,
    hitCount: Number(r.hit_count ?? 0),
    rejectReason: (r.reject_reason as string | null) ?? null,
    createdAt: String(r.created_at),
    verifiedAt: (r.verified_at as string | null) ?? null,
  };
}

const COLS = `id, workspace_id, goal_key, goal, plan, status, learned_by_agent,
  source_task_id, hit_count, reject_reason, created_at::text AS created_at,
  verified_at::text AS verified_at`;

export interface RecordProcedureInput {
  workspaceId: string;
  goal: string;
  plan: ProcedureStep[];
  learnedByAgent: string;
  sourceTaskId: string | null;
}

/**
 * Record a learned procedure and run the promotion safety check. Returns the
 * final status. Idempotent on (workspace, goal_key): the first learner of a goal
 * owns the entry. Best effort: a memory failure never breaks the task that
 * learned it.
 */
export async function recordLearnedProcedure(
  input: RecordProcedureInput,
): Promise<{ status: MemoryStatus }> {
  const goalKey = normalizeGoalKey(input.goal);
  const verdict = verifyProcedureForPromotion(input.plan);
  const status: MemoryStatus = verdict.safe ? "promoted" : "rejected";

  await writeQuery(
    `INSERT INTO instinct_agent_memory
       (workspace_id, goal_key, goal, plan, status, learned_by_agent,
        source_task_id, reject_reason, verified_at)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8, NOW())
     ON CONFLICT (workspace_id, goal_key) DO NOTHING`,
    [
      input.workspaceId,
      goalKey,
      input.goal,
      JSON.stringify(input.plan),
      status,
      input.learnedByAgent,
      input.sourceTaskId,
      verdict.reason,
    ],
    { expectRows: 0 },
  );

  trackEvent("agent.procedure_learned", input.learnedByAgent, "agent", {
    workspace_id: input.workspaceId,
    goal_key: goalKey,
    status,
    step_count: input.plan.length,
  });
  if (status === "promoted") {
    trackEvent("agent.procedure_promoted", input.learnedByAgent, "agent", {
      workspace_id: input.workspaceId,
      goal_key: goalKey,
    });
  } else {
    trackEvent("agent.procedure_rejected", input.learnedByAgent, "agent", {
      workspace_id: input.workspaceId,
      goal_key: goalKey,
      reason: (verdict.reason ?? "").slice(0, 200),
    });
  }

  return { status };
}

/**
 * Find a promoted procedure for a goal, the inheritance path. Counts the hit and
 * emits agent.procedure_inherited. Returns null when there is nothing to inherit.
 */
export async function findPromotedProcedure(
  workspaceId: string,
  goal: string,
  byAgent: string,
): Promise<MemoryEntry | null> {
  const goalKey = normalizeGoalKey(goal);
  const res = await safeQuery<Record<string, unknown>>(
    `SELECT ${COLS} FROM instinct_agent_memory
      WHERE workspace_id = $1 AND goal_key = $2 AND status = 'promoted'`,
    [workspaceId, goalKey],
  );
  const row = res.rows[0];
  if (!row) return null;
  const entry = mapRow(row);

  try {
    await safeQuery(
      `UPDATE instinct_agent_memory SET hit_count = hit_count + 1 WHERE id = $1`,
      [entry.id],
    );
  } catch {
    /* hit count is a metric; never block inheritance on it */
  }
  trackEvent("agent.procedure_inherited", byAgent, "agent", {
    workspace_id: workspaceId,
    goal_key: goalKey,
    learned_by_agent: entry.learnedByAgent,
  });
  return entry;
}

export async function listMemory(
  workspaceId: string,
  status?: MemoryStatus,
): Promise<MemoryEntry[]> {
  const args: unknown[] = [workspaceId];
  let clause = "";
  if (status) {
    args.push(status);
    clause = ` AND status = $${args.length}`;
  }
  const res = await safeQuery<Record<string, unknown>>(
    `SELECT ${COLS} FROM instinct_agent_memory
      WHERE workspace_id = $1${clause}
      ORDER BY created_at DESC LIMIT 200`,
    args,
  );
  return res.rows.map(mapRow);
}

/** Human override: promote or reject a procedure manually. */
export async function setMemoryStatus(
  id: string,
  workspaceId: string,
  status: MemoryStatus,
  actor: { userId: string; role: string },
  reason?: string,
): Promise<MemoryEntry | null> {
  const res = await writeQuery<Record<string, unknown>>(
    `UPDATE instinct_agent_memory
        SET status = $3, reject_reason = $4, verified_at = NOW()
      WHERE id = $1 AND workspace_id = $2
      RETURNING ${COLS}`,
    [id, workspaceId, status, status === "rejected" ? (reason ?? "manual") : null],
  );
  const row = res.rows[0];
  if (!row) return null;
  const entry = mapRow(row);
  trackEvent(
    status === "promoted" ? "agent.procedure_promoted" : "agent.procedure_rejected",
    actor.userId,
    actor.role,
    { workspace_id: workspaceId, goal_key: entry.goalKey, manual: true },
  );
  return entry;
}

export async function getMemoryEntry(
  id: string,
  workspaceId: string,
): Promise<MemoryEntry | null> {
  const res = await query<Record<string, unknown>>(
    `SELECT ${COLS} FROM instinct_agent_memory WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}
