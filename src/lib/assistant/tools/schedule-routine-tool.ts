/**
 * schedule_routine — "run my morning every weekday at 8".
 *
 * The way a chain stops being something you remember to type and becomes
 * something that meets you.
 *
 * WHAT IT REFUSES TO GUESS
 *
 * A cadence without a time, or a time without a cadence, is not a schedule and
 * this will not invent the missing half. Something firing at 3am forever
 * because a sentence was ambiguous is a thing nobody connects back to what they
 * typed, and the fix is one clarifying question rather than a wrong standing
 * appointment.
 *
 * It also refuses a command that names no routine. A schedule pointing at
 * nothing would fail every morning, and the person would find out from a
 * notification rather than from the sentence they just typed.
 */
import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import { matchRoutine } from "@/lib/assistant/routines/catalogue";
import { matchSavedRoutine } from "@/lib/assistant/routines/saved";
import { parseSchedule, describeSchedule, isValidTimeZone } from "@/lib/assistant/routines/schedule";
import {
  upsertSchedule,
  cancelSchedule,
  listSchedules,
} from "@/lib/assistant/routines/schedule-store";
import type { ToolDef, ToolResult } from "./types";

const ParamSchema = z.object({
  action: z.enum(["create", "cancel", "list"]),
  command: z.string().min(2).max(120).optional(),
  /** The whole sentence, so the cadence and time can be read from it. */
  text: z.string().max(300).optional(),
});
type Params = z.infer<typeof ParamSchema>;

interface ScheduleData {
  action: Params["action"];
  command?: string;
  scheduled?: string;
  count?: number;
}

/* THE COMMAND IS CAPTURED WHOLE, verb included.
   The built-in chains are called "run my morning" and "weekly review", so
   stripping a leading "run" leaves "my morning", which matches nothing. This
   captures everything before the cadence and lets resolveCommand below do the
   forgiving part, rather than guessing at the grammar here. */
const CREATE_RE = /^(.+?)\s+(every\s+\w+.*|daily.*|each\s+day.*)$/i;
const CANCEL_RE = /^(?:stop|cancel|unschedule)\s+(?:running\s+)?(.+?)(?:\s+(?:every|daily|each)\b.*)?$/i;
const LIST_RE = /^(?:what(?:'s| is)\s+scheduled|my\s+schedules?|list\s+(?:my\s+)?schedules?|what\s+runs\s+automatically)[\s.?!]*$/i;

export function matchScheduleIntent(message: string): Params | null {
  const text = message.trim();
  if (text.length > 300) return null;

  if (LIST_RE.test(text)) return { action: "list" };

  const create = CREATE_RE.exec(text);
  /* Both halves required. "run my morning every weekday" has no time and is a
     question, not an instruction. */
  if (create && /\bat\s+\d/i.test(text)) {
    return { action: "create", command: create[1].trim().toLowerCase(), text };
  }

  const cancel = CANCEL_RE.exec(text);
  if (cancel && /\b(?:stop|cancel|unschedule)\b/i.test(text)) {
    return { action: "cancel", command: cancel[1].trim().toLowerCase() };
  }

  return null;
}

/**
 * Find the routine somebody meant.
 *
 * Tried as typed first, then with "run " in front. People say "stop running my
 * morning" and "schedule my morning every weekday", and the chain is called
 * "run my morning". Refusing on that difference would be the product being
 * pedantic about its own naming at somebody who was perfectly clear.
 */
async function resolveCommand(
  owner: { workspaceId: string; userId: string },
  command: string,
): Promise<{ routine: import("@/lib/assistant/routines/types").Routine; command: string } | null> {
  for (const candidate of [command, `run ${command}`]) {
    const routine = matchRoutine(candidate) ?? (await matchSavedRoutine(owner, candidate));
    if (routine) return { routine, command: routine.command };
  }
  return null;
}

/** The person's zone, or a sane fallback. Never guessed from an IP. */
function zoneFor(): string {
  const configured = process.env.DEFAULT_TIME_ZONE;
  if (configured && isValidTimeZone(configured)) return configured;
  /* The server's own zone is the honest default when nobody has said. It is
     stated back to the person in the confirmation, so a wrong one is
     correctable in the next sentence rather than silently wrong forever. */
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return local && isValidTimeZone(local) ? local : "UTC";
}

export const scheduleRoutineTool: ToolDef<Params, ScheduleData> = {
  name: "schedule_routine",
  description:
    "Run a routine on a standing schedule, stop one, or list what is scheduled. A scheduled run stops at every step that needs a person.",
  capability: "*",
  paramSchema: ParamSchema,
  matchIntent: matchScheduleIntent,
  async handler(params, ctx): Promise<ToolResult<ScheduleData>> {
    const owner = { workspaceId: ctx.workspaceId || "default", userId: ctx.userId };

    if (params.action === "list") {
      const rows = await listSchedules(owner);
      trackEvent("assistant.tool_invoked", ctx.userId, ctx.userRole, {
        tool: "schedule_routine",
        action: "list",
        count: rows.length,
      });
      if (rows.length === 0) {
        return {
          ok: true,
          data: { action: "list", count: 0 },
          answer:
            "Nothing runs automatically yet. Say something like “run my morning every weekday at 8am” and I will start meeting you with it.",
        };
      }
      return {
        ok: true,
        data: { action: "list", count: rows.length },
        answer: [
          `${rows.length === 1 ? "One routine runs" : `${rows.length} routines run`} automatically:`,
          ...rows.map((r) => `- **${r.command}** ${describeSchedule(r.schedule)}`),
          "",
          "Each one stops at every step that needs you, and nothing is sent or filed without you confirming it.",
        ].join("\n"),
      };
    }

    const command = (params.command ?? "").trim().toLowerCase();
    if (!command) {
      return { ok: false, code: "validation", message: "Tell me which routine, and I will schedule it." };
    }

    if (params.action === "cancel") {
      /* Cancel resolves too, so "stop running my morning" stops the schedule
         stored under the routine's real command. */
      const resolvedForCancel = (await resolveCommand(owner, command))?.command ?? command;
      const stopped = await cancelSchedule(owner, resolvedForCancel);
      trackEvent("assistant.tool_invoked", ctx.userId, ctx.userRole, {
        tool: "schedule_routine",
        action: "cancel",
        found: stopped,
      });
      return {
        ok: true,
        data: { action: "cancel", command: resolvedForCancel },
        answer: stopped
          ? `Stopped. **${resolvedForCancel}** will not run on its own any more, and you can still run it by name.`
          : `Nothing was scheduled for **${resolvedForCancel}**, so there was nothing to stop.`,
      };
    }

    /* A schedule pointing at nothing fails every morning, and the person finds
       out from a notification instead of from the sentence they just typed. */
    const resolved = await resolveCommand(owner, command);
    if (!resolved) {
      return {
        ok: false,
        code: "validation",
        message: `I do not have a routine called "${command}". Say “what can you do” to see the ones that exist, or describe your day and I will build one.`,
      };
    }

    const timeZone = zoneFor();
    const schedule = parseSchedule(params.text ?? "", timeZone);
    if (!schedule) {
      return {
        ok: false,
        code: "validation",
        message:
          "I need both how often and what time, and I would rather ask than guess: something like “every weekday at 8am” or “every Monday at 9am”.",
      };
    }

    const saved = await upsertSchedule(owner, resolved.command, schedule, new Date());
    if (!saved.ok) {
      return { ok: false, code: "internal", message: `I could not set that up: ${saved.reason}.` };
    }

    trackEvent("assistant.tool_invoked", ctx.userId, ctx.userRole, {
      tool: "schedule_routine",
      action: "create",
      routine_id: resolved.routine.id,
      cadence: schedule.cadence,
      hour: schedule.hour,
    });

    const humanSteps = resolved.routine.steps.filter((s) => s.kind === "human").length;
    return {
      ok: true,
      data: { action: "create", command: resolved.command, scheduled: describeSchedule(schedule) },
      answer: [
        `Done. **${resolved.command}** will run ${describeSchedule(schedule)} (${timeZone}), starting ${saved.nextRunAt.toISOString().slice(0, 10)}.`,
        humanSteps > 0
          ? `It will do the gathering and then wait for you at ${humanSteps === 1 ? "the step that is yours" : `the ${humanSteps} steps that are yours`}, and I will send you the result when it is ready.`
          : "I will send you the result when it is ready.",
        "Nothing is sent or filed without you confirming it, whether you are there or not.",
      ].join(" "),
    };
  },
};

registerTool(scheduleRoutineTool);
