/**
 * create_task_form — surfaces a form for creating a Microsoft To-Do
 * task. Trigger phrases: "create task", "add a task", "new task",
 * "create a todo".
 *
 * Differs from the CRM action tool (create_external_record with
 * objectType: task) — that one writes to Salesforce; this one writes
 * to MS To-Do via POST /api/tasks.
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { listCachedTaskLists, createTask } from "@/lib/integrations/microsoft-tasks";
import { registerTool } from "./registry";
import type { ToolContext, ToolDef, ToolResult } from "./types";
import { taskFormSpec, type TaskListOption } from "@/lib/assistant/forms/specs";

/* MS To-Do lists named like "Flagged Emails" are read-only and would
 * 400 on POST. The tasks page filters them out — same logic here so
 * the dropdown only offers writable destinations. */
const READ_ONLY_LIST_NAMES = new Set<string>([
  "Flagged Emails",
  "Flagged emails",
  "flaggedEmails",
]);

const ParamSchema = z.object({
  title: z.string().min(1).max(200).optional(),
});
type Params = z.infer<typeof ParamSchema>;

interface CreateTaskFormData {
  formKind: "create_task";
}

/* "create a task" wins; "create a task to follow up Friday" routes to
   the CRM action tool (which is registered BEFORE this one). The CRM
   tool requires the phrase "log a <verb>" / "create a task to ..." —
   we capture the bare "create task" form-trigger here. */
const INTENT_RE =
  /\b(?:create|add|new|make)\s+(?:an?\s+)?(?:to[\s-]?do|task)\b(?!\s+to\s+\w)/i;
const TITLE_RE = /\b(?:titled|called|named|about|for)\s+["']?([^"'\n]{2,80})["']?/i;

function matchTaskFormIntent(message: string): Params | null {
  if (!INTENT_RE.test(message)) return null;
  const params: Params = {};
  const t = TITLE_RE.exec(message);
  if (t) params.title = t[1].trim();
  return params;
}

/* On-behalf-of-owner task creation for an agent principal. Returns a normal
 * ToolResult (NO form), so a successful create counts as a real "ran" step in
 * the governed executor. Never throws: a missing title, a disconnected owner
 * mailbox, or a Graph error all degrade to a clear ok:false the executor records
 * as a failed step (not a false "succeeded"). */
async function createTaskAsAgent(
  params: Params,
  principal: NonNullable<ToolContext["agentPrincipal"]>,
): Promise<ToolResult<CreateTaskFormData>> {
  const title = params.title?.trim();
  if (!title) {
    return {
      ok: false,
      code: "validation",
      message: 'A task needs a title. Try: add a task titled "Doctors Appointment".',
    };
  }
  const ownerUserId = principal.ownerUserId;
  try {
    const lists = await listCachedTaskLists(ownerUserId);
    const target = lists.find((l) => !READ_ONLY_LIST_NAMES.has(l.displayName));
    if (!target) {
      return {
        ok: false,
        code: "internal",
        message:
          "The agent owner has no writable Microsoft To-Do list connected. Connect Microsoft To-Do so the agent can create tasks on the owner's behalf.",
      };
    }
    await createTask(ownerUserId, target.msListId, { title });
    trackEvent("assistant.form_offered", ownerUserId, principal.role, {
      form_kind: "create_task",
      autocompleted_by_agent: true,
      agent_id: principal.agentId,
    });
    return {
      ok: true,
      data: { formKind: "create_task" },
      answer: `Created task "${title}" in Microsoft To-Do (list: ${target.displayName}) on behalf of the owner.`,
      sources: [],
    };
  } catch (err) {
    return {
      ok: false,
      code: "internal",
      message: `Could not create the task on behalf of the owner: ${(err as Error).message}`,
    };
  }
}

export const createTaskFormTool: ToolDef<Params, CreateTaskFormData> = {
  name: "create_task_form",
  description:
    "Surface a form in the chat for creating a Microsoft To-Do task. Title is required.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent: matchTaskFormIntent,
  async handler(params, ctx): Promise<ToolResult<CreateTaskFormData>> {
    /* Agent path: an autonomous agent cannot fill and submit a UI form, so it
     * EXECUTES the create directly, on behalf of its owner (writing to the
     * owner's Microsoft To-Do). The OGIAM gate already authorized this mutation
     * before the handler ran; the create is attributed to the agent acting for
     * the owner. This is what makes "Agent1, add a task titled X" actually
     * create the task instead of returning a form nobody fills. */
    if (ctx.agentPrincipal) {
      return createTaskAsAgent(params, ctx.agentPrincipal);
    }

    /* Pull the user's writable To-Do lists so the form can offer a
     * real dropdown instead of falling back to the literal "default"
     * string (Graph rejects that with ErrorInvalidIdMalformed). */
    let listOptions: TaskListOption[] = [];
    try {
      const lists = await listCachedTaskLists(ctx.userId);
      listOptions = lists
        .filter((l) => !READ_ONLY_LIST_NAMES.has(l.displayName))
        .map((l) => ({ value: l.msListId, label: l.displayName }));
    } catch (err) {
      /* Cache miss / DB down — surface an empty list so the form
       * renders with a "connect MS To-Do" hint instead of crashing. */
      console.warn("[create-task-form] listCachedTaskLists failed:", (err as Error).message);
    }

    trackEvent("assistant.form_offered", ctx.userId, ctx.userRole, {
      form_kind: "create_task",
      prefilled_title: params.title ? true : false,
      list_count: listOptions.length,
    });
    return {
      ok: true,
      data: { formKind: "create_task" },
      answer: "Fill in the task below.",
      form: taskFormSpec({ title: params.title }, listOptions),
    };
  },
};

registerTool(createTaskFormTool);
