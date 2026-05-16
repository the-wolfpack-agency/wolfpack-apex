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
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import { taskFormSpec } from "@/lib/assistant/forms/specs";

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

export const createTaskFormTool: ToolDef<Params, CreateTaskFormData> = {
  name: "create_task_form",
  description:
    "Surface a form in the chat for creating a Microsoft To-Do task. Title is required.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent: matchTaskFormIntent,
  async handler(params, ctx): Promise<ToolResult<CreateTaskFormData>> {
    trackEvent("assistant.form_offered", ctx.userId, ctx.userRole, {
      form_kind: "create_task",
      prefilled_title: params.title ? true : false,
    });
    return {
      ok: true,
      data: { formKind: "create_task" },
      answer:
        "Fill in the task below. Title is required — the Create button stays disabled until it's set.",
      form: taskFormSpec({
        title: params.title,
      }),
    };
  },
};

registerTool(createTaskFormTool);
