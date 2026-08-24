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
import { PROMPT_GUIDE } from "@/lib/assistant/prompt-corpus";
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

/**
 * THE FIRST THING ANYBODY TYPES.
 *
 * This was anchored end to end with no room for the words people
 * actually put in the middle. Measured against the deployed assistant on
 * 2026-08-23: "what can you do?" returned the capability list, and "what
 * can you actually do for me today?" spent 1,483 tokens to answer "I
 * don't have a confident answer for that. Could you rephrase, or open a
 * support ticket."
 *
 * Five of ten ordinary phrasings missed, including "what can you help me
 * with?" and "how can you help?", which are the two commonest ways the
 * question gets asked. It is the worst question to fail, because it is
 * the first one anybody types and the answer to it is the only thing
 * standing between a new user and giving up.
 *
 * WIDENING THIS IS THE RISK, NOT THE FIX. A capability matcher that
 * swallows real questions is the same failure as arr matching inside
 * warranty, and it would be a worse one here because this tool answers
 * confidently and never says it is unsure. So the discriminator is that
 * the question has NO OBJECT: "what can you help me with" is asking for
 * the menu, "what can you help me with on the Detroit account" is asking
 * about Detroit. Filler is allowed, an object is not, and the corpus
 * carries both sides.
 */
const FILLER = "(?:\\s+(?:actually|really|even|just|please|exactly))*";
const TAIL = "(?:\\s+(?:for\\s+me|for\\s+us|here|today|right\\s+now|around\\s+here|in\\s+here))*";
/* A leading "so" or "and" is how somebody carries on a conversation, and
   it made "so what do you actually do" miss a matcher that already knew
   "what do you do". Filler at the front is not a different question. */
const LEAD = "(?:so|and|ok(?:ay)?|right|well)?[\\s,]*";

const ASKS = [
  `what${FILLER}\\s+can\\s+you${FILLER}\\s+do`,
  `what${FILLER}\\s+can\\s+you${FILLER}\\s+help\\s+(?:me|us)\\s+with`,
  `how${FILLER}\\s+can\\s+you${FILLER}\\s+help(?:\\s+(?:me|us))?`,
  `what${FILLER}\\s+can\\s+i\\s+ask(?:\\s+you)?`,
  `what${FILLER}\\s+should\\s+i\\s+ask(?:\\s+you)?`,
  `what\\s+are\\s+you\\s+(?:able\\s+to\\s+do|capable\\s+of)`,
  `what\\s+do\\s+you\\s+(?:actually\\s+)?do`,
  `what\\s+else\\s+can\\s+you\\s+do`,
  /* "give me the tour" is what somebody says when they want to be shown
     round rather than told a list. Distinctive enough to take. */
  `give\\s+me\\s+(?:the\\s+)?tour`,
  `show\\s+me\\s+(?:a|the)\\s+tour`,
  `where\\s+(?:do|should)\\s+i\\s+start`,
  `help`,
  `show\\s+(?:me\\s+)?(?:your\\s+)?(?:capabilities|commands|routines)`,
];

const INTENT_RE = new RegExp(`^${LEAD}(?:${ASKS.join("|")})${TAIL}[\\s.?!]*$`, "i");

/** The capability a guide entry's tool is gated behind, so the openers
 *  respect the same gate the list above does: suggesting something the
 *  reader cannot run is a menu of disappointments. */
function toolCapability(toolName: string): string {
  return getTools().find((t) => t.name === toolName)?.capability ?? "*";
}

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

    /* THE MOST USEFUL THING THEY CAN TYPE, and it is not on the list above.
       A person reading a capability list still has to map their own job onto
       it, which is the translation this product is supposed to do for them.
       Saying so here costs one line and turns a menu into a conversation. */
    lines.push("");
    lines.push(
      "If none of that quite matches your job, describe your day instead: tell me what you do on a Monday, in order, and I will map it onto what I can and cannot do, then offer to chain the rest into one command.",
    );

    if (withheldCount > 0) {
      lines.push("");
      /* Counted, not named. Saying HOW MANY is honest about the boundary;
         naming them is a tour of what somebody is not allowed to touch. */
      lines.push(
        `There ${withheldCount === 1 ? "is 1 more tool" : `are ${withheldCount} more tools`} your role does not have access to.`,
      );
    }

    /* THREE THINGS TO TYPE, NOT A LIST OF TOOLS.
     *
     * The list above says what exists. Somebody who has just asked what
     * this does still has to guess at the words, and the whole reason the
     * capability question was worth fixing is that guessing is where
     * people give up.
     *
     * Taken from the verified guide rather than written here, so it can
     * never suggest a phrasing that stopped working: a test runs every
     * one of them through the real matchers. */
    const openers = PROMPT_GUIDE.filter(
      (g) =>
        /* Not the question they just asked. Suggesting "what can you do?"
           to somebody reading the answer to it is the kind of thing that
           only shows up when you read the output rather than the code. */
        g.tool !== "what_can_you_do" &&
        canInvokeTool(ctx.userRole, toolCapability(g.tool)),
    ).slice(0, 3);
    if (openers.length > 0) {
      lines.push("");
      lines.push("**If you would rather just start**");
      for (const g of openers) {
        lines.push(`- \`${g.say[0]}\` — ${g.gives}`);
      }
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
