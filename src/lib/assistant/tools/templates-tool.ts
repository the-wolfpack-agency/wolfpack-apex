/**
 * routine_templates — workflows somebody can adopt instead of describing.
 *
 * WHAT MAKES THIS DIFFERENT FROM A CATALOGUE
 *
 * Every template is checked against the LIVE registry and the reader's own role
 * before it is offered, using the same check that guards a saved chain. So the
 * library can say "these four will work for you today, and these two need a CRM
 * connected" rather than presenting nine equal-looking options, two of which
 * fail on adoption.
 *
 * A catalogue that half-fails on contact is worse than a short one: the first
 * thing somebody learns about the product is that it promises things it cannot
 * do.
 *
 * ADOPTING IS A CONFIRMATION, not a click. The chosen template is held as a
 * pending action and saved when they agree, through the same path everything
 * else uses.
 */
import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool, getTools } from "./registry";
import { savePendingAction } from "./pending-actions";
import { ROUTINE_TEMPLATES, templateById } from "@/lib/assistant/routines/templates";
import { checkRoutine } from "@/lib/assistant/routines/heal";
import { isReservedCommand } from "@/lib/assistant/routines/saved";
import type { ToolDef, ToolResult } from "./types";

const ParamSchema = z.object({
  /** Adopt one by name. Absent means show the library. */
  adopt: z.string().min(2).max(120).optional(),
});
type Params = z.infer<typeof ParamSchema>;

interface TemplatesData {
  offered: number;
  blocked: number;
  adopted?: string;
}

const LIST_RE =
  /\b(?:workflow\s+templates?|routine\s+templates?|show\s+(?:me\s+)?(?:the\s+)?templates?|what\s+could\s+i\s+automate|what\s+can\s+i\s+automate|prebuilt\s+workflows?|pre-built\s+workflows?)\b/i;
const ADOPT_RE = /\b(?:use|adopt|set\s+up|add)\s+(?:the\s+)?["“]?([a-z][a-z0-9 ]{4,60}?)["”]?\s*(?:template|workflow)\b/i;

export function matchTemplatesIntent(message: string): Params | null {
  const text = message.trim();
  if (text.length > 200) return null;
  const adopt = ADOPT_RE.exec(text);
  if (adopt) return { adopt: adopt[1].trim().toLowerCase() };
  return LIST_RE.test(text) ? {} : null;
}

export const routineTemplatesTool: ToolDef<Params, TemplatesData> = {
  name: "routine_templates",
  description:
    "Show pre-built workflows that would work in this workspace, and set one up. Each is checked against what is actually connected before it is offered.",
  capability: "*",
  paramSchema: ParamSchema,
  matchIntent: matchTemplatesIntent,
  async handler(params, ctx): Promise<ToolResult<TemplatesData>> {
    const tools = getTools();

    /* Checked against reality, per reader. The same template is offered to one
       person and withheld from another, correctly, because the difference is
       what their role can actually run. */
    const checked = ROUTINE_TEMPLATES.map((t) => ({
      template: t,
      health: checkRoutine(t, tools, ctx.userRole),
    }));
    const ready = checked.filter((c) => c.health.ok);
    const blocked = checked.filter((c) => !c.health.ok);

    if (params.adopt) {
      const wanted = params.adopt;
      const found =
        checked.find((c) => c.template.command.toLowerCase() === wanted) ??
        checked.find((c) => c.template.command.toLowerCase().includes(wanted)) ??
        checked.find((c) => templateById(wanted)?.id === c.template.id);

      if (!found) {
        return {
          ok: false,
          code: "validation",
          message: `I do not have a template called "${wanted}". Say "show me the templates" to see what there is.`,
        };
      }

      if (!found.health.ok) {
        /* Named plainly. "That template is unavailable" teaches somebody
           nothing; the missing piece is the thing they can go and fix. */
        return {
          ok: false,
          code: "validation",
          message: [
            `**${found.template.command}** will not work here yet:`,
            ...found.health.problems.map((p) => `- ${p.detail}`),
            "Set that up and I will add it.",
          ].join("\n"),
        };
      }

      if (isReservedCommand(found.template.command)) {
        return {
          ok: false,
          code: "validation",
          message: `"${found.template.command}" is already a built-in routine, so it is available without adopting anything.`,
        };
      }

      await savePendingAction({
        userId: ctx.userId,
        toolName: "save_routine",
        params: { routine: stripTemplateFields(found.template), workspaceId: ctx.workspaceId ?? "default" },
        description: `Add the "${found.template.command}" workflow`,
      }).catch(() => undefined);

      trackEvent("assistant.tool_invoked", ctx.userId, ctx.userRole, {
        tool: "routine_templates",
        action: "adopt_offered",
        template_id: found.template.id,
      });

      const humanSteps = found.template.steps.filter((s) => s.kind === "human").length;
      /* "stop for you at 0 of them" is what a count reads like when the answer
         is none. A chain that only looks things up has nothing to confirm, and
         saying so is the more useful sentence anyway: it tells somebody this
         one just answers. */
      const stopping =
        humanSteps === 0
          ? "and would not need to stop: it only reads, so there is nothing to confirm"
          : `and stop for you at ${humanSteps === 1 ? "one of them" : `${humanSteps} of them`}`;
      return {
        ok: true,
        data: { offered: ready.length, blocked: blocked.length, adopted: found.template.command },
        answer: [
          `**${found.template.command}** would run ${found.template.steps.length} steps ${stopping}.`,
          found.template.outcome,
          "",
          "Say yes and it becomes a command you can type. You can change it afterwards.",
        ].join("\n"),
      };
    }

    trackEvent("assistant.tool_invoked", ctx.userId, ctx.userRole, {
      tool: "routine_templates",
      action: "list",
      ready: ready.length,
      /* WHAT PEOPLE ARE SHOWN AND CANNOT USE. Over a few workspaces this is the
         clearest statement of which integration to prioritise: it is measured
         demand rather than a guess. */
      blocked: blocked.length,
    });

    const lines: string[] = [];
    if (ready.length > 0) {
      lines.push(`${ready.length === 1 ? "One workflow works" : `${ready.length} workflows work`} here today:`);
      lines.push("");
      for (const { template } of ready) {
        lines.push(`- **${template.command}** (${template.forRole}). ${template.outcome}`);
      }
      lines.push("");
      lines.push('Say "use the ... workflow" and I will set one up. Nothing is sent or filed without you confirming it.');
    } else {
      lines.push("None of the pre-built workflows will run here yet, which usually means nothing is connected.");
    }

    if (blocked.length > 0) {
      lines.push("");
      /* Shown, not hidden. A person who can see what is nearly available knows
         what connecting a system would buy them. */
      lines.push(`${blocked.length === 1 ? "One more needs" : `${blocked.length} more need`} something set up first:`);
      for (const { template, health } of blocked) {
        lines.push(`- **${template.command}**: ${health.problems[0]?.detail ?? "not available yet"}`);
      }
    }

    return { ok: true, data: { offered: ready.length, blocked: blocked.length }, answer: lines.join("\n") };
  },
};

/** A template becomes an ordinary routine when somebody adopts it. */
function stripTemplateFields(t: (typeof ROUTINE_TEMPLATES)[number]) {
  return {
    id: t.id,
    command: t.command,
    description: t.description,
    audience: t.audience,
    steps: t.steps,
  };
}

registerTool(routineTemplatesTool);
