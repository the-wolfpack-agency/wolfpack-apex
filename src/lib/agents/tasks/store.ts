/**
 * Agent task store (migration 173). Create, read, and update assigned tasks.
 */

import { query, writeQuery, safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import type { AgentTask, TaskStatus, TaskStep } from "./types";

function mapRow(r: Record<string, unknown>): AgentTask {
  return {
    id: String(r.id),
    agentId: String(r.agent_id),
    workspaceId: String(r.workspace_id),
    assignedBy: String(r.assigned_by),
    goal: String(r.goal),
    status: String(r.status) as TaskStatus,
    steps: (r.steps as TaskStep[] | null) ?? [],
    resultSummary: (r.result_summary as string | null) ?? null,
    createdAt: String(r.created_at),
    startedAt: (r.started_at as string | null) ?? null,
    finishedAt: (r.finished_at as string | null) ?? null,
  };
}

const COLS = `id, agent_id, workspace_id, assigned_by, goal, status, steps,
  result_summary, created_at::text AS created_at, started_at::text AS started_at,
  finished_at::text AS finished_at`;

export interface CreateTaskInput {
  agentId: string;
  workspaceId: string;
  assignedBy: string;
  assignedByRole: string;
  goal: string;
}

export async function createTask(input: CreateTaskInput): Promise<AgentTask> {
  const { rows } = await writeQuery<Record<string, unknown>>(
    `INSERT INTO instinct_agent_tasks (agent_id, workspace_id, assigned_by, goal)
     VALUES ($1,$2,$3,$4) RETURNING ${COLS}`,
    [input.agentId, input.workspaceId, input.assignedBy, input.goal],
    { expectRows: 1 },
  );
  const task = mapRow(rows[0]);
  trackEvent("agent.task_assigned", input.assignedBy, input.assignedByRole, {
    agent_id: input.agentId,
    task_id: task.id,
    workspace_id: input.workspaceId,
  });
  return task;
}

export async function getTask(id: string, workspaceId: string): Promise<AgentTask | null> {
  const res = await safeQuery<Record<string, unknown>>(
    `SELECT ${COLS} FROM instinct_agent_tasks WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

export async function listTasksForAgent(
  agentId: string,
  workspaceId: string,
  limit = 50,
): Promise<AgentTask[]> {
  const lim = Math.min(Math.max(limit, 1), 200);
  const res = await safeQuery<Record<string, unknown>>(
    `SELECT ${COLS} FROM instinct_agent_tasks
      WHERE agent_id = $1 AND workspace_id = $2
      ORDER BY created_at DESC LIMIT $3`,
    [agentId, workspaceId, lim],
  );
  return res.rows.map(mapRow);
}

/** Claim the next queued task for an agent and mark it running, atomically. */
export async function claimNextQueuedTask(
  agentId: string,
  workspaceId: string,
): Promise<AgentTask | null> {
  const res = await query<Record<string, unknown>>(
    `UPDATE instinct_agent_tasks
        SET status = 'running', started_at = NOW()
      WHERE id = (
        SELECT id FROM instinct_agent_tasks
         WHERE agent_id = $1 AND workspace_id = $2 AND status = 'queued'
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING ${COLS}`,
    [agentId, workspaceId],
  );
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

/** Persist the final state of a task after the executor ran it. */
export async function completeTask(
  id: string,
  status: TaskStatus,
  steps: TaskStep[],
  resultSummary: string,
): Promise<void> {
  await writeQuery(
    `UPDATE instinct_agent_tasks
        SET status = $2, steps = $3::jsonb, result_summary = $4, finished_at = NOW()
      WHERE id = $1`,
    [id, status, JSON.stringify(steps), resultSummary],
    { expectRows: 0 },
  );
}
