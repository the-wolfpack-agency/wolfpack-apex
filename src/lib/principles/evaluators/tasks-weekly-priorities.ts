/**
 * Real evaluator for `tasks.weekly_priority_count`.
 *
 * Counts the user's currently-active high-importance tasks across every
 * Microsoft To Do list and emits ONE observation per user per evaluation
 * — a roll-up signal mirroring the calendar-focus-block "one row per
 * day" shape (not per-task like tasks-overdue).
 *
 * Score tiers (Wolfpack principle: max 2–3 priorities/week):
 *   count <= 2 → +0.5 (clearly under cap)
 *   count == 3 →  0.0 (right at the limit, neutral)
 *   count == 4 → -0.3
 *   count 5–6  → -0.6
 *   count >= 7 → -0.9 (drift)
 *
 * "High importance" comes from Microsoft Graph todoTask `importance`
 * ("low" | "normal" | "high"). Tasks marked high == priorities; tasks
 * left at default "normal" don't count toward the cap.
 *
 * Defensive: any token / scope / 5xx error returns []; the cron loop
 * never breaks on a single user.
 */

import { getValidToken } from "@/lib/microsoft-graph";
import type {
  EvaluationContext,
  Observation,
} from "@/lib/principles/validators";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

interface RawTaskList {
  id?: string;
}

interface RawTask {
  id?: string;
  title?: string;
  status?: string;
  importance?: "low" | "normal" | "high";
  webLink?: string;
  createdDateTime?: string;
}

async function fetchTaskLists(
  accessToken: string,
): Promise<{ rows: RawTaskList[]; status: number }> {
  const res = await fetch(`${GRAPH_BASE}/me/todo/lists`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return { rows: [], status: res.status };
  const data = (await res.json().catch(() => ({}))) as { value?: RawTaskList[] };
  return { rows: Array.isArray(data.value) ? data.value : [], status: 200 };
}

async function fetchHighImportanceActive(
  accessToken: string,
  listId: string,
): Promise<RawTask[]> {
  /* Graph $filter supports `importance eq 'high' and status ne 'completed'`
     directly. Keeps the response light + the count exact. */
  const filter = "importance eq 'high' and status ne 'completed'";
  const path =
    `me/todo/lists/${encodeURIComponent(listId)}/tasks` +
    `?$top=200&$filter=${encodeURIComponent(filter)}`;
  const res = await fetch(`${GRAPH_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return [];
  const data = (await res.json().catch(() => ({}))) as { value?: RawTask[] };
  return Array.isArray(data.value) ? data.value : [];
}

/**
 * Map a priority count to an Observation score. Pure for unit testing.
 *
 * The cap is 3 (Wolfpack principle wording: "Maximum of 2–3 priorities
 * per week"). Going over 3 is the drift; staying at-or-under is the win.
 */
export function scoreForPriorityCount(count: number): number {
  if (count <= 2) return 0.5;
  if (count === 3) return 0.0;
  if (count === 4) return -0.3;
  if (count <= 6) return -0.6;
  return -0.9;
}

export async function evaluateTasksWeeklyPriorities(
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

  const priorityTitles: Array<{ id: string; title: string; webLink?: string }> = [];
  for (const list of lists.rows) {
    if (!list.id) continue;
    let tasks: RawTask[];
    try {
      tasks = await fetchHighImportanceActive(token.accessToken, list.id);
    } catch {
      continue;
    }
    for (const t of tasks) {
      if (!t.id) continue;
      priorityTitles.push({
        id: t.id,
        title: (t.title ?? "").slice(0, 200),
        webLink: t.webLink,
      });
    }
  }

  const count = priorityTitles.length;
  const score = scoreForPriorityCount(count);

  /* Stitch the top-3 titles into the notes so the evidence drill-down
     shows leadership exactly which work the user has flagged as
     priority. Beyond 3 we just summarize the count. */
  const sample = priorityTitles
    .slice(0, 3)
    .map((p) => p.title)
    .filter((t) => t.length > 0)
    .join(" · ");
  const notes =
    sample.length > 0
      ? `${count} high-importance active task${count === 1 ? "" : "s"}: ${sample}${count > 3 ? " …" : ""}`
      : `${count} high-importance active tasks`;

  return [
    {
      surface: "tasks",
      surfaceSubtype: "weekly_priority_count",
      subjectUserId: userId,
      observedAt: new Date().toISOString(),
      score,
      evidence: {
        kind: "tasks_priority_rollup",
        metric: { name: "priority_count", value: count },
        notes,
      },
    },
  ];
}
