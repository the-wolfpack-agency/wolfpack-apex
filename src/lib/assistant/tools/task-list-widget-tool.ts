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

/**
 * ASKING WHAT IS WAITING ON YOU, IN THE WORDS PEOPLE USE.
 *
 * This was anchored end to end and required the literal word "task" or
 * "todo". Swept on 2026-08-24: seven of eight ordinary phrasings missed,
 * including "what is waiting on me", "what is on my plate" and "anything
 * overdue".
 *
 * It is the question somebody asks every morning, and it is one of the
 * few this product can answer from their own data in milliseconds. Every
 * missed phrasing was instead answered by a model, from whatever the
 * knowledge base had nearest.
 *
 * "Task" is the word the software uses. Plate, waiting, outstanding,
 * owe and overdue are the words a person uses for the same thing.
 */
const INTENT_RE = new RegExp(
  [
    /* the original literal set, kept exactly */
    `^(?:tasks|my\\s+tasks|open\\s+tasks|show\\s+(?:me\\s+)?(?:my\\s+)?tasks|task\\s+list|to-?do\\s+list|todos?|show\\s+tasks)[\\s.?!]*$`,
    /* what a person actually types */
    `\\bwhat(?:'s| is| have i got)?\\s+(?:is\\s+)?(?:still\\s+)?(?:waiting|outstanding|left)\\s+(?:on|for|with)?\\s*me\\b`,
    `\\bwhat(?:'s| is)\\s+on\\s+my\\s+plate\\b`,
    /* These two have to stand alone. "what do I owe the dealer group" and
       "anything overdue on the invoice" are questions about a party and a
       document, and a task list answering them would be trespassing on a
       real question the same way the financials tool did on warranty. */
    `\\bwhat\\s+do\\s+i\\s+owe(?:\\s+(?:people|anyone|anybody))?[\\s.?!]*$`,
    `\\bwhat\\s+have\\s+i\\s+got\\s+outstanding[\\s.?!]*$`,
    `\\banything\\s+(?:overdue|outstanding|waiting)(?:\\s+(?:on\\s+me|for\\s+me))?[\\s.?!]*$`,
    `\\bmy\\s+open\\s+(?:tasks|items|work)\\b`,
    `\\bwhat\\s+am\\s+i\\s+supposed\\s+to\\s+be\\s+doing\\b`,
    `\\bwhat\\s+(?:should|do)\\s+i\\s+(?:need\\s+to\\s+)?(?:do|work\\s+on)\\s+(?:today|next)\\b`,
  ].join("|"),
  "i",
);

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
