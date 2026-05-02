/**
 * Real evaluator for `tasks.weekly_finish_rate`.
 *
 * "What gets started gets finished within the week" — Wolfpack
 * principle 7 (Finish Strong). Counts tasks the user CREATED inside the
 * eval window vs how many of those have already moved to `completed`.
 * Emits ONE observation per user per evaluation (rollup signal).
 *
 * Design notes:
 *   - Started count comes from createdDateTime within the window. We
 *     intentionally don't count tasks created BEFORE the window — those
 *     belong to a prior week's finish-rate.
 *   - Finished count is "of those started, how many show status =
 *     completed right now". A task started this week + completed next
 *     week therefore counts as drift in week 1 and is invisible in week
 *     2 (good — week 2 didn't start it).
 *   - The cron runs Monday morning evaluating the previous Mon→Sun
 *     window via the standard windowStart/windowEnd ctx; same evaluator
 *     is also fine to call mid-week because the score scales with
 *     ratio rather than threshold.
 *
 * Score:
 *   ratio >= 0.9  → +0.6  (strong finish)
 *   0.7 <= ratio  → +0.3
 *   0.5 <= ratio  →  0.0  (neutral)
 *   0.3 <= ratio  → -0.3
 *   ratio  < 0.3  → -0.6  (drift)
 *   started == 0  →  +0.0 + emit zero-volume note (nothing to assess)
 */

import { getValidToken } from "@/lib/microsoft-graph";
import {
  snapToUtcDay,
  type EvaluationContext,
  type Observation,
} from "@/lib/principles/validators";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

interface RawTaskList {
  id?: string;
}

interface RawTask {
  id?: string;
  title?: string;
  status?: string;
  createdDateTime?: string;
  completedDateTime?: { dateTime?: string };
  webLink?: string;
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

async function fetchTasksCreatedSince(
  accessToken: string,
  listId: string,
  windowStartISO: string,
): Promise<RawTask[]> {
  const filter = `createdDateTime ge ${windowStartISO}`;
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
 * Map a (started, finished) pair to a score. Pure for unit testing.
 * Returns the score AND a tier label for evidence.
 */
export function scoreForFinishRate(
  started: number,
  finished: number,
): { score: number; tier: string; ratio: number } {
  if (started === 0) {
    return { score: 0, tier: "no_starts", ratio: 0 };
  }
  const ratio = finished / started;
  let score = 0;
  let tier = "neutral";
  if (ratio >= 0.9) {
    score = 0.6;
    tier = "strong";
  } else if (ratio >= 0.7) {
    score = 0.3;
    tier = "good";
  } else if (ratio >= 0.5) {
    score = 0;
    tier = "neutral";
  } else if (ratio >= 0.3) {
    score = -0.3;
    tier = "weak";
  } else {
    score = -0.6;
    tier = "drift";
  }
  return { score, tier, ratio };
}

export async function evaluateTasksWeeklyFinishRate(
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

  let started = 0;
  let finished = 0;
  for (const list of lists.rows) {
    if (!list.id) continue;
    let tasks: RawTask[];
    try {
      tasks = await fetchTasksCreatedSince(
        token.accessToken,
        list.id,
        ctx.windowStart,
      );
    } catch {
      continue;
    }
    for (const t of tasks) {
      started++;
      if (t.status === "completed") finished++;
    }
  }

  const { score, tier, ratio } = scoreForFinishRate(started, finished);
  const pct = started === 0 ? 0 : Math.round(ratio * 100);
  const notes =
    started === 0
      ? "no tasks started in window — nothing to assess"
      : `${finished}/${started} started-this-window tasks completed (${pct}%, ${tier})`;

  return [
    {
      surface: "tasks",
      surfaceSubtype: "weekly_finish_rate",
      subjectUserId: userId,
      observedAt: snapToUtcDay(ctx.windowEnd),
      score,
      evidence: {
        kind: "tasks_finish_rollup",
        metric: { name: "finish_pct", value: pct },
        notes,
      },
    },
  ];
}
