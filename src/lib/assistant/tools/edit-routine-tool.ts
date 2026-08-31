/**
 * edit_routine — change one step without describing the day again.
 *
 * Three operations, and no fourth. Show me the steps, drop one, move one, swap
 * the tool one uses. Each is a sentence somebody could say out loud, which is
 * the test a builder fails: nobody says "drag the node onto the canvas".
 *
 * EVERY EDIT IS CHECKED BEFORE IT IS OFFERED, and offered before it is saved.
 * The check is the order invariant, which is the thing a person cannot see: a
 * later step reads what an earlier one wrote, and a tidy-up that breaks it
 * fails the next morning with a message about a missing slot, long after
 * anybody would connect the two.
 */
import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool, getTools } from "./registry";
import { savePendingAction } from "./pending-actions";
import { matchRoutine } from "@/lib/assistant/routines/catalog";
import { matchSavedRoutine, isReservedCommand } from "@/lib/assistant/routines/saved";
import { removeStep, moveStep, replaceTool, describeSteps } from "@/lib/assistant/routines/edit";
import type { ToolDef, ToolResult } from "./types";

const ParamSchema = z.object({
  command: z.string().min(2).max(120),
  action: z.enum(["show", "remove", "move", "replace"]),
  position: z.number().int().min(1).max(50).optional(),
  to: z.number().int().min(1).max(50).optional(),
  tool: z.string().min(2).max(60).optional(),
});
type Params = z.infer<typeof ParamSchema>;

interface EditData {
  command: string;
  action: Params["action"];
  steps?: number;
}

const SHOW_RE = /^(?:show|list)\s+(?:me\s+)?(?:the\s+)?steps\s+(?:in|of|for)\s+(.+?)[\s.?!]*$/i;
const REMOVE_RE = /^(?:remove|drop|delete)\s+step\s+(\d{1,2})\s+(?:from|in|of)\s+(.+?)[\s.?!]*$/i;
const MOVE_RE = /^move\s+step\s+(\d{1,2})\s+to\s+(?:position\s+)?(\d{1,2})\s+(?:in|of|for)\s+(.+?)[\s.?!]*$/i;
const REPLACE_RE = /^(?:use|switch\s+to)\s+([a-z_][a-z0-9_]{2,59})\s+(?:for|in)\s+step\s+(\d{1,2})\s+(?:in|of|for)\s+(.+?)[\s.?!]*$/i;

export function matchEditIntent(message: string): Params | null {
  const text = message.trim();
  if (text.length > 200) return null;

  const show = SHOW_RE.exec(text);
  if (show) return { command: show[1].trim().toLowerCase(), action: "show" };

  const remove = REMOVE_RE.exec(text);
  if (remove) {
    return { command: remove[2].trim().toLowerCase(), action: "remove", position: Number(remove[1]) };
  }

  const move = MOVE_RE.exec(text);
  if (move) {
    return {
      command: move[3].trim().toLowerCase(),
      action: "move",
      position: Number(move[1]),
      to: Number(move[2]),
    };
  }

  const replace = REPLACE_RE.exec(text);
  if (replace) {
    return {
      command: replace[3].trim().toLowerCase(),
      action: "replace",
      position: Number(replace[2]),
      tool: replace[1],
    };
  }

  return null;
}

export const editRoutineTool: ToolDef<Params, EditData> = {
  name: "edit_routine",
  description:
    "Show the steps in one of your routines, or remove, reorder, or swap the tool a step uses. Every change is offered before it is saved.",
  capability: "*",
  paramSchema: ParamSchema,
  matchIntent: matchEditIntent,
  async handler(params, ctx): Promise<ToolResult<EditData>> {
    const owner = { workspaceId: ctx.workspaceId || "default", userId: ctx.userId };
    const command = params.command.trim().toLowerCase();

    const routine = matchRoutine(command) ?? (await matchSavedRoutine(owner, command));
    if (!routine) {
      return {
        ok: false,
        code: "validation",
        message: `I do not have a routine called "${command}". Say "what can you do" to see the ones that exist.`,
      };
    }

    if (params.action === "show") {
      return {
        ok: true,
        data: { command, action: "show", steps: routine.steps.length },
        answer: [
          `**${routine.command}** runs these, in order:`,
          "",
          describeSteps(routine),
          "",
          'To change it: "remove step 3 from ' + routine.command + '", "move step 4 to 1 in ' + routine.command + '", or "use search_mail for step 2 in ' + routine.command + '".',
        ].join("\n"),
      };
    }

    /* A BUILT-IN IS NOT EDITED IN PLACE. Changing a documented command for one
       person would mean the docs describe something they do not have. Their
       edit becomes their own copy, which is also what they wanted. */
    const editingBuiltIn = isReservedCommand(routine.command);

    const result =
      params.action === "remove"
        ? removeStep(routine, params.position ?? 0)
        : params.action === "move"
          ? moveStep(routine, params.position ?? 0, params.to ?? 0)
          : replaceTool(routine, params.position ?? 0, params.tool ?? "", getTools(), ctx.userRole);

    if (!result.ok) {
      /* The reason, not "invalid". Every refusal here is something the person
         can act on by saying something different. */
      return { ok: false, code: "validation", message: `I cannot do that: ${result.reason}.` };
    }

    const saveAs = editingBuiltIn ? `my ${routine.command}` : routine.command;
    await savePendingAction({
      userId: ctx.userId,
      toolName: "save_routine",
      params: {
        routine: { ...result.routine, command: saveAs },
        workspaceId: owner.workspaceId,
      },
      description: `Save the change to "${saveAs}"`,
    }).catch(() => undefined);

    trackEvent("assistant.tool_invoked", ctx.userId, ctx.userRole, {
      tool: "edit_routine",
      action: params.action,
      routine_id: routine.id,
      /* Which edits people actually make. A step everybody removes is a step
         that should not have been in the template. */
      built_in: editingBuiltIn,
    });

    return {
      ok: true,
      data: { command: saveAs, action: params.action, steps: result.routine.steps.length },
      answer: [
        result.summary,
        "",
        describeSteps(result.routine),
        "",
        editingBuiltIn
          ? `That is a built-in routine, so saying yes saves your version as **${saveAs}** and leaves the original alone.`
          : "Say yes to save it.",
      ].join("\n"),
    };
  },
};

registerTool(editRoutineTool);
