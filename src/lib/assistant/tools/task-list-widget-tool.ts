/**
 * task_list_widget — renders an inline list of the user's open tasks.
 *
 * Trigger phrases:
 *   "tasks" / "my tasks" / "open tasks" / "show me my tasks"
 *   "task list" / "to-do list" / "todos" / "show tasks"
 *
 * Reads from the locally-cached MS Tasks store (listCachedTasks)
 * rather than hitting Graph directly — same source the /tasks page
 * uses, so the chat shows what the user sees on the page. Falls back
 * gracefully to an empty list if the cache is empty (sync not yet
 * run for this user).
 */

import { z } from "zod";
import { listCachedTasks } from "@/lib/integrations/microsoft-tasks";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import type {
  TaskListWidgetSpec,
  TaskListItem,
} from "@/lib/assistant/widgets/types";

const ParamSchema = z.object({
  limit: z.number().int().min(1).max(50).default(20),
});
type Params = z.infer<typeof ParamSchema>;

interface TaskWidgetData {
  kind: "task_list";
  taskCount: number;
  overdueCount: number;
}

const INTENT_RE =
  /^(?:tasks|my\s+tasks|open\s+tasks|show\s+(?:me\s+)?(?:my\s+)?tasks|task\s+list|to-?do\s+list|todos?|show\s+tasks)[\s.?!]*$/i;

function matchTaskWidgetIntent(message: string): Params | null {
  if (!INTENT_RE.test(message.trim())) return null;
  return { limit: 20 };
}

export const taskListWidgetTool: ToolDef<Params, TaskWidgetData> = {
  name: "task_list_widget",
  description:
    "Render a list of the user's open tasks in the chat. The user can click into any task to open it. Use when the user asks for 'tasks' or 'my todos' as a standalone prompt.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent: matchTaskWidgetIntent,
  async handler(params, ctx): Promise<ToolResult<TaskWidgetData>> {
    let tasks: TaskListItem[] = [];
    let overdueCount = 0;
    let answer: string;
    try {
      /* listCachedTasks filters; pass an empty filter + status=notStarted+inProgress
       * by reading all and filtering client-side, since the cached helper
       * already excludes completed when status is not set. We pull a
       * generous limit and trim. */
      const res = await listCachedTasks(ctx.userId, { limit: params.limit });
      const now = Date.now();
      tasks = res.tasks
        .filter((t) => t.status !== "completed")
        .map((t) => {
          const overdue = t.dueAt ? Date.parse(t.dueAt) < now : false;
          if (overdue) overdueCount += 1;
          return {
            id: t.id,
            title: t.title,
            status: t.status as TaskListItem["status"],
            importance: t.importance,
            dueAt: t.dueAt,
            listId: t.listId,
          };
        });
      answer =
        tasks.length === 0
          ? "You have no open tasks. Nice."
          : `You have ${tasks.length} open task${tasks.length === 1 ? "" : "s"}${overdueCount > 0 ? ` (${overdueCount} overdue)` : ""}. Click any row to open it.`;
    } catch (err) {
      console.warn("[task-list-widget] listCachedTasks failed:", (err as Error).message);
      answer =
        "I couldn't load your tasks just now. Open Tasks from the sidebar to retry.";
    }

    trackEvent("assistant.widget_offered", ctx.userId, ctx.userRole, {
      widget_kind: "task_list",
      task_count: tasks.length,
      overdue_count: overdueCount,
    });

    const spec: TaskListWidgetSpec = {
      kind: "task_list",
      title: "Open tasks",
      subtitle:
        tasks.length > 0
          ? overdueCount > 0
            ? `${tasks.length} open · ${overdueCount} overdue`
            : `${tasks.length} open`
          : undefined,
      tasks,
    };

    return {
      ok: true,
      data: {
        kind: "task_list",
        taskCount: tasks.length,
        overdueCount,
      },
      answer,
      widget: spec,
    };
  },
};

registerTool(taskListWidgetTool);
