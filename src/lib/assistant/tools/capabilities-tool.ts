/**
 * what_can_you_do — the product, described from the product.
 *
 * WHY THIS IS NOT A HELP PAGE
 *
 * A written list of what the assistant can do is out of date the day somebody
 * adds a tool, and there is no build step that catches it. Worse, it describes
 * what the product can do IN GENERAL rather than what THIS person can do,
 * which is the only question they were asking: a sales lead reading about the
 * financials tools learns something they cannot use.
 *
 * So this reads the live registry and the routine catalogue, filters by the
 * caller's role through the same gate the dispatcher enforces, and describes
 * what is left. Add a tool and it appears here. Remove one and it disappears.
 * The description can never drift from the capability, because it IS the
 * capability being read out.
 *
 * ROUTINES FIRST, DELIBERATELY
 *
 * The chains are what somebody actually wants: one command that runs the six
 * things they would otherwise do in five windows. A list that opens with 40
 * individual tools buries them, and the person goes back to doing it by hand.
 */
import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import { getTools } from "./registry";
import { canInvokeTool } from "./gate";
import { BUILT_IN_ROUTINES } from "@/lib/assistant/routines/catalogue";
import type { ToolDef, ToolResult } from "./types";

const ParamSchema = z.object({});
type Params = z.infer<typeof ParamSchema>;

interface CapabilitiesData {
  routineCount: number;
  toolCount: number;
  /** Tools this role may NOT invoke. Reported as a number, never a list: a
   *  person cannot act on the names of things they are not allowed to use, and
   *  printing them turns an answer into a description of the permission
   *  system. */
  withheldCount: number;
}

const INTENT_RE =
  /^(?:what\s+can\s+you\s+do|what\s+can\s+i\s+ask(?:\s+you)?|what\s+are\s+you\s+(?:able\s+to\s+do|capable\s+of)|help|what\s+do\s+you\s+do|show\s+(?:me\s+)?(?:your\s+)?(?:capabilities|commands|routines))[\s.?!]*$/i;

export function matchCapabilitiesIntent(message: string): Params | null {
  return INTENT_RE.test(message.trim()) ? {} : null;
}

/**
 * Group tools by the part of the job they belong to.
 *
 * By SUBJECT, not by the module they live in. Somebody asking what the product
 * does is thinking about their mail and their calendar, not about which file a
 * tool was written in, and a list organised by our architecture reads as a list
 * organised by nothing.
 */
const AREAS: Array<{ title: string; match: RegExp }> = [
  { title: "Mail and people", match: /mail|email|who_is|contact|people|message/ },
  { title: "Calendar and meetings", match: /calendar|meeting|availability|event/ },
  { title: "Work and tasks", match: /task|goal|okr|feature|time|pending|workflow/ },
  { title: "Code and deployments", match: /github|issue|pull_request|deployment|vercel|scan/ },
  { title: "Customers and records", match: /external_record|crm|related_records|aggregate|filter/ },
  { title: "Money", match: /financial|invoice|receipt|fx/ },
  { title: "Knowledge", match: /brain|search|org_facts|team_fact|upload|hr_doc/ },
];

function areaFor(toolName: string): string {
  return AREAS.find((a) => a.match.test(toolName))?.title ?? "Everything else";
}

/** Sentence case, and no trailing full stop, so the list reads evenly. */
function trim(description: string): string {
  const first = description.split(/(?<=\.)\s/)[0] ?? description;
  return first.replace(/\.$/, "");
}

export const capabilitiesTool: ToolDef<Params, CapabilitiesData> = {
  name: "what_can_you_do",
  description:
    "Describe what this assistant can do for the person asking, read from the live tool registry and filtered to their role.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent: matchCapabilitiesIntent,
  async handler(_params, ctx): Promise<ToolResult<CapabilitiesData>> {
    const all = getTools();
    /* The SAME gate the dispatcher enforces. Listing something the caller
       cannot run would be a menu of disappointments, and a second copy of the
       permission logic here is how the menu and the runtime come to disagree. */
    const usable = all.filter(
      (t) => canInvokeTool(ctx.userRole, t.capability) && t.name !== "what_can_you_do",
    );
    const withheldCount = all.length - usable.length - 1;

    const routines = BUILT_IN_ROUTINES;
    const lines: string[] = [];

    lines.push("**Whole jobs, in one command**");
    lines.push("");
    for (const r of routines) {
      lines.push(`- \`${r.command}\` — ${r.description}`);
    }
    lines.push("");
    lines.push(
      "Each of those runs several of the tools below in order and stops when it needs you. Nothing is sent, filed or told to anybody without you confirming it.",
    );
    lines.push("");

    const byArea = new Map<string, string[]>();
    for (const t of usable) {
      const area = areaFor(t.name);
      if (!byArea.has(area)) byArea.set(area, []);
      byArea.get(area)!.push(`- ${trim(t.description)}`);
    }

    lines.push("**One thing at a time**");
    for (const { title } of AREAS) {
      const items = byArea.get(title);
      if (!items || items.length === 0) continue;
      lines.push("");
      lines.push(`_${title}_`);
      lines.push(...items.slice(0, 8));
    }
    const rest = byArea.get("Everything else");
    if (rest && rest.length > 0) {
      lines.push("");
      lines.push("_Everything else_");
      lines.push(...rest.slice(0, 8));
    }

    if (withheldCount > 0) {
      lines.push("");
      /* Counted, not named. Saying HOW MANY is honest about the boundary;
         naming them is a tour of what somebody is not allowed to touch. */
      lines.push(
        `There ${withheldCount === 1 ? "is 1 more tool" : `are ${withheldCount} more tools`} your role does not have access to.`,
      );
    }

    trackEvent("assistant.tool_invoked", ctx.userId, ctx.userRole, {
      tool: "what_can_you_do",
      /* What people can reach, per role, over time: the number that says
         whether the gate is set somewhere sensible. */
      usable_tools: usable.length,
      withheld_tools: withheldCount,
      routines: routines.length,
      ...(ctx.workflowId ? { workflow_id: ctx.workflowId } : {}),
    });

    return {
      ok: true,
      data: { routineCount: routines.length, toolCount: usable.length, withheldCount },
      answer: lines.join("\n"),
    };
  },
};

registerTool(capabilitiesTool);
