/**
 * Real evaluator for `tasks.overdue_rate`.
 *
 * Reads the user's Microsoft To Do tasks via Graph and emits one
 * observation per overdue task (status != completed AND dueDateTime
 * < now). Score is -0.5 per overdue task — moderate magnitude so a
 * single overdue doesn't dominate the principle's weekly aggregate.
 *
 * Defensive: missing Tasks scope, revoked token, or 5xx returns [].
 */

import { getValidToken } from "@/lib/microsoft-graph";
import type {
  EvaluationContext,
  Observation,
} from "@/lib/principles/validators";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

interface RawTaskList {
  id?: string;
  displayName?: string;
}

interface RawTask {
  id?: string;
  title?: string;
  status?: "notStarted" | "inProgress" | "waitingOnOthers" | "deferred" | "completed";
  dueDateTime?: { dateTime?: string; timeZone?: string };
  webLink?: string;
}

async function fetchTaskLists(
  accessToken: string,
): Promise<{ rows: RawTaskList[]; status: number }> {
  const res = await fetch(`${GRAPH_BASE}/me/todo/lists`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return { rows: [], status: res.status };
  const data = (await res.json().catch(() => ({}))) as {
    value?: RawTaskList[];
  };
  return { rows: Array.isArray(data.value) ? data.value : [], status: 200 };
}

async function fetchTasks(
  accessToken: string,
  listId: string,
): Promise<RawTask[]> {
  /* $filter status ne 'completed' to keep the response light, then
     filter by dueDateTime in code (Graph doesn't support nested
     dueDateTime/dateTime in $filter). */
  const path =
    `me/todo/lists/${encodeURIComponent(listId)}/tasks` +
    `?$top=200&$filter=${encodeURIComponent("status ne 'completed'")}`;
  const res = await fetch(`${GRAPH_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return [];
  const data = (await res.json().catch(() => ({}))) as { value?: RawTask[] };
  return Array.isArray(data.value) ? data.value : [];
}

export function isOverdue(task: RawTask, nowMs = Date.now()): boolean {
  if (task.status === "completed") return false;
  const due = task.dueDateTime?.dateTime;
  if (!due) return false;
  const t = Date.parse(due);
  return Number.isFinite(t) && t < nowMs;
}

export async function evaluateTasksOverdue(
  ctx: EvaluationContext,
): Promise<Observation[]> {
  const userId = ctx.subjectUserId;
  if (!userId) return [];
  const token = await getValidToken(userId);
  if (!token) return [];

  let lists: { rows: RawTaskList[]; status: number };
  try {
    lists = await fetchTaskLists(token.accessToken);
  } catch {
    return [];
  }
  if (lists.status !== 200) return [];

  const observations: Observation[] = [];
  const nowMs = Date.now();
  for (const list of lists.rows) {
    if (!list.id) continue;
    let tasks: RawTask[];
    try {
      tasks = await fetchTasks(token.accessToken, list.id);
    } catch {
      continue;
    }
    for (const t of tasks) {
      if (!isOverdue(t, nowMs)) continue;
      observations.push({
        surface: "tasks",
        surfaceSubtype: "todo_overdue",
        subjectUserId: userId,
        observedAt: t.dueDateTime?.dateTime ?? new Date(nowMs).toISOString(),
        score: -0.5,
        evidence: {
          kind: "todo_overdue",
          sourceId: t.id,
          sourceUrl: t.webLink,
          notes: t.title?.slice(0, 200),
          metric: {
            name: "days_overdue",
            value: Math.round(
              (nowMs - Date.parse(t.dueDateTime!.dateTime!)) /
                (24 * 60 * 60 * 1000),
            ),
          },
        },
      });
    }
  }
  return observations;
}
