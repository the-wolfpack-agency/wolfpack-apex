/**
 * #6: classify a factory prompt into a coarse TASK TYPE, and grade per
 * (model, task-type) - so we can see which model ships best for migrations vs UI
 * vs API etc., not just an overall average. Measurement first (a later step can
 * route on it); this is the read-model + the pure classifier.
 *
 * classifyTaskType is pure + deterministic (first matching category wins).
 * loadTaskTypeGrades reads the pipeline_run events (model + status + task_type),
 * workspace-scoped, never throws.
 */
import { safeQuery } from "@/lib/db";

export type TaskType = "migration" | "test" | "ui" | "api" | "refactor" | "docs" | "other";

/** First-match-wins keyword heuristic. Order matters: more specific before generic. */
const PATTERNS: ReadonlyArray<[TaskType, RegExp]> = [
  ["migration", /\b(migrat\w*|alter table|create table|create index|\.sql\b|schema change)\b/i],
  ["test", /\b(unit test|e2e|playwright|jest|\.test\.|\.spec\.|test coverage|write a test)\b/i],
  ["ui", /\b(component|react|\.tsx\b|button|widget|panel|page|css|styl(e|ing)|layout|form)\b/i],
  ["api", /\b(api route|endpoint|route handler|rest|webhook|\bhandler\b|request\/response)\b/i],
  ["refactor", /\b(refactor|rename|extract|de-?dupe|clean ?up|consolidate|simplify)\b/i],
  ["docs", /\b(readme|docs?\b|documentation|release notes|changelog|comment\w*)\b/i],
];

export function classifyTaskType(prompt: string): TaskType {
  const p = (prompt ?? "").toLowerCase();
  for (const [type, re] of PATTERNS) if (re.test(p)) return type;
  return "other";
}

export interface ModelTaskGrade {
  model: string;
  taskType: TaskType | string;
  runs: number;
  /** ready_for_pr / runs - first-pass clean-enough-to-hand-off rate. */
  readyRate: number;
}
export interface TaskTypeGrades {
  windowDays: number;
  byModelTask: ModelTaskGrade[];
}

interface Row extends Record<string, unknown> { model: string; task_type: string; runs: number; ready: number }

/** Pure: fold run counts into per-(model,task-type) grades, most runs first. */
export function summarizeTaskTypeGrades(rows: readonly Row[], windowDays: number): TaskTypeGrades {
  const byModelTask = rows
    .map((r) => {
      const runs = Number(r.runs) || 0;
      return {
        model: r.model || "unknown",
        taskType: r.task_type || "other",
        runs,
        readyRate: runs > 0 ? (Number(r.ready) || 0) / runs : 0,
      };
    })
    .filter((g) => g.runs > 0)
    .sort((a, b) => b.runs - a.runs || a.model.localeCompare(b.model) || String(a.taskType).localeCompare(String(b.taskType)));
  return { windowDays, byModelTask };
}

/** Per-(model,task-type) grades for a workspace over `days`. Never throws. */
export async function loadTaskTypeGrades(workspaceId: string, days = 30): Promise<TaskTypeGrades> {
  const d = Math.min(Math.max(Math.trunc(days), 1), 365);
  const { rows } = await safeQuery<Row>(
    `SELECT
       coalesce(metadata->>'model', 'unknown') AS model,
       coalesce(metadata->>'task_type', 'other') AS task_type,
       count(*)::int AS runs,
       count(*) FILTER (WHERE metadata->>'status' = 'ready_for_pr')::int AS ready
       FROM instinct_events
      WHERE event_type = 'ai_code.pipeline_run'
        AND timestamp > now() - ($1 || ' days')::interval
        AND metadata->>'workspace_id' = $2
      GROUP BY 1, 2`,
    [String(d), workspaceId],
  );
  return summarizeTaskTypeGrades(rows, d);
}
