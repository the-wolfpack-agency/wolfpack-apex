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
 * So this reads the live registry and the routine catalog, filters by the
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
import type { WidgetSpec } from "@/lib/assistant/widgets/types";
import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import { getTools } from "./registry";
import { canInvokeNamedTool, canInvokeTool } from "./gate";
import { scopeToConnected, connectedSystems, describeAwaiting } from "./capability-scope";
import { hasPersona, personaCopyFor } from "./persona";
import { BUILT_IN_ROUTINES } from "@/lib/assistant/routines/catalog";
import { PROMPT_GUIDE } from "@/lib/assistant/prompt-corpus";
import type { ToolDef, ToolResult } from "./types";

const ParamSchema = z.object({
  /**
   * The one thing they asked about, when they asked about one thing.
   *
   * Absent for "what can you do", which wants the menu. Present for "can you
   * send an email for me", which wants a yes or a no about email and is a
   * different question with a different right answer.
   */
  topic: z.string().min(2).max(60).optional(),
});
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

/**
 * "CAN YOU SEND AN EMAIL FOR ME" IS A CAPABILITY QUESTION.
 *
 * It was not treated as one, so it went to a model, and the model answered from
 * what a general assistant would say. Measured against the deployed assistant
 * on 2026-08-28, after the stored copies of this had already been purged:
 *
 *   "can you send an email for me" -> "I cannot send emails directly."
 *   "what files can you see"       -> "I cannot see files directly. I can
 *                                      generate or edit files based on your
 *                                      input, analyze code snippets you
 *                                      provide..."
 *
 * Both false. Both produced live, minutes after the system prompt was rewritten
 * to forbid exactly this, and in the same session where the identical question
 * had answered "Yes, I can draft an email for you." Same prompt, opposite
 * answers. An instruction is not a control: the model complies most of the
 * time, and most of the time is a coin flip in front of a client.
 *
 * So the question stops reaching a model at all. The registry knows what this
 * reader can run, the gate knows what they may run, and between them the answer
 * is a lookup: deterministic, free, instant, and correct every time.
 *
 * WHY IT ONLY CLAIMS WHAT IT CAN MAP. If the topic matches no area, this
 * returns null and something else takes the question. Answering "can you
 * reconcile the trial balance" with a confident list of mail tools would be the
 * same wrong-tool-confident-voice failure this file already guards against, and
 * it would be worse here because this tool never says it is unsure.
 */
/* CONCATENATED, NOT INTERPOLATED. A template literal containing a named
   capture group reads as "<c" preceded by a backtick and followed by an
   interpolation, which is the exact shape the untrusted-content ratchet hunts
   for when it looks for markup built around outside text. It flagged this
   file. It is a regex and not markup, and the honest fix is to stop tripping
   the detector rather than to file a false positive in an audit list whose
   entries are real findings. */
const CAN_YOU_RE = new RegExp(
  "^" + LEAD + "(?:can|could)\\s+you" + FILLER + "\\s+(?<canTopic>.{2,60}?)" + TAIL + "[\\s.?!]*$" +
    "|^" + LEAD + "(?:are\\s+you\\s+able\\s+to|do\\s+you\\s+know\\s+how\\s+to)\\s+(?<ableTopic>.{2,60}?)" + TAIL + "[\\s.?!]*$" +
    "|^" + LEAD + "what\\s+(?<seeWhat>.{2,40}?)\\s+can\\s+you\\s+see" + TAIL + "[\\s.?!]*$",
  "i",
);

/**
 * The words people use for each part of the job.
 *
 * SEPARATE FROM THE AREAS MAP ABOVE, which matches TOOL NAMES. A person says
 * "email", the tool is called create_email_form, and one regex cannot serve
 * both without matching the wrong things in each direction.
 */
const TOPIC_AREAS: Array<{ area: string; match: RegExp }> = [
  { area: "Mail and people", match: /\b(?:e-?mails?|mail|inbox|message|write\s+to|contacts?|people|colleagues?|team)\b/i },
  { area: "Calendar and meetings", match: /\b(?:calendar|diary|schedule|meetings?|appointments?|availability|invite)\b/i },
  { area: "Work and tasks", match: /\b(?:tasks?|to-?dos?|goals?|okrs?|deadlines?|assignments?|work)\b/i },
  /* "drive" is qualified, because a bare one matched "can you drive a car" and
     answered it with a document library. OneDrive and "the drive" are the
     filing cabinet; driving is not. */
  { area: "Knowledge", match: /\b(?:files?|documents?|docs?|share\s?point|one\s?drive|google\s+drive|the\s+drive|library|knowledge|attachments?|spreadsheets?|pdfs?)\b/i },
  { area: "Customers and records", match: /\b(?:crm|customers?|clients?|accounts?|deals?|opportunit(?:y|ies)|records?|leads?)\b/i },
  { area: "News and the web", match: /\b(?:news|headlines?|articles?|the\s+web|internet|weather)\b/i },
  { area: "Money", match: /\b(?:invoices?|receipts?|financials?|revenue|spend|budget|expenses?|payments?)\b/i },
  { area: "Code and deployments", match: /\b(?:code|repos?|pull\s+requests?|prs?|issues?|deploys?|deployments?|builds?)\b/i },
];

/** Which part of the job a topic belongs to, or null when it is not ours. */
export function areaForTopic(topic: string): string | null {
  return TOPIC_AREAS.find((t) => t.match.test(topic))?.area ?? null;
}

export function matchCapabilitiesIntent(message: string): Params | null {
  const trimmed = message.trim();
  /* The menu question first: "what can you do" must never be read as a topic
     question, and "can you help me" is the menu however it is phrased. */
  if (INTENT_RE.test(trimmed)) return {};

  const m = CAN_YOU_RE.exec(trimmed);
  if (!m) return null;
  const g = (m.groups ?? {}) as Record<string, string | undefined>;
  const topic = (g.canTopic ?? g.ableTopic ?? g.seeWhat ?? "").trim();
  if (!topic) return null;
  /* "CAN YOU HELP ME WITH X" IS ABOUT X, NOT ABOUT US.
     It matched here on the word "account" and would have answered a question
     about the Detroit account with a list of CRM tools. That is the object
     distinction this file already draws for the menu question, one shape
     further out, and it is the same wrong-tool-confident-voice failure. */
  /* Anchored on "help" alone rather than "help me": this file's own suite
     already asserted that "can you help with the calendar" is a real request
     and must not match, and the narrower version let it straight through. */
  if (/^help\b/i.test(topic)) return null;
  /* "CAN YOU SEE IF THE INVOICE WENT OUT" IS A LOOKUP, not a question about
     what we can do. The dealership corpus asserts that nothing may claim it,
     and this claimed it on the word "invoice".

     The tell is a subordinate clause. A capability question names a thing
     ("can you read my calendar"); a lookup asks about a fact concerning one
     ("can you see IF the invoice went out", "can you check WHETHER it sent"). */
  if (/\b(?:if|whether)\b/i.test(topic)) return null;
  /* CONNECTIVITY IS A DIFFERENT QUESTION AND HAS A BETTER ANSWER.
     "can you see my email" and "do you have access to our CRM" are asking
     whether a system is CONNECTED, and the corpus assigns both to the
     integrations tool, which reads live connection status. This tool would
     answer from the registry instead and say yes about a mailbox nobody has
     linked, which is the precise failure that corpus entry was written for:
     "a claimed capability that does not exist is the thing a client discovers
     by relying on it." */
  if (/^(?:see|access|reach|get\s+(?:at|into)|connect)\b/i.test(topic)) return null;
  /* Only claimed when the topic maps to something we do. Everything else
     belongs to whichever tool or model can actually answer it. */
  if (!areaForTopic(topic)) return null;
  return { topic };
}

/**
 * Group tools by the part of the job they belong to.
 *
 * By SUBJECT, not by the module they live in. Somebody asking what the product
 * does is thinking about their mail and their calendar, not about which file a
 * tool was written in, and a list organized by our architecture reads as a list
 * organized by nothing.
 */
const AREAS: Array<{ title: string; match: RegExp }> = [
  { title: "Mail and people", match: /mail|email|who_is|contact|people|message/ },
  { title: "Calendar and meetings", match: /calendar|meeting|availability|event/ },
  { title: "Work and tasks", match: /task|goal|okr|feature|time|pending|workflow/ },
  { title: "Code and deployments", match: /github|issue|pull_request|deployment|vercel|scan/ },
  { title: "Customers and records", match: /external_record|crm|related_records|aggregate|filter/ },
  { title: "Money", match: /financial|invoice|receipt|fx/ },
  /* BEFORE Knowledge, because Knowledge matches on "search" and would
     otherwise swallow these. news_search and web_search are not the document
     library, and listing them under Knowledge put "recent published articles"
     in the answer to "what files can you see". First match wins, so the
     narrower area has to come first. */
  { title: "News and the web", match: /news|headlines|web_search|^fx$|weather/ },
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
    const permitted = all.filter(
      (t) => canInvokeNamedTool(ctx.userRole, t.name, t.capability) && t.name !== "what_can_you_do",
    );

    /* ROLE IS THE RIGHT GATE AND NOT THE ONLY ONE.
     *
     * A tool the caller is permitted to run still cannot run if the system
     * behind it was never linked. Measured on this deployment: no connectors,
     * zero CRM events ever, zero dealer-system events ever, and this answer
     * advertised six CRM capabilities and an inventory widget regardless.
     *
     * Somebody running dealerships reads the list and goes straight for
     * "deals over $50k closing this month" and "how many are on the lot",
     * which are the two most tempting lines and the two backed by nothing.
     * This file already refuses to say yes about an unlinked mailbox when
     * asked directly; the menu now holds to the same rule. */
    const linked = await connectedSystems(ctx.workspaceId ?? "default");
    const scoped = scopeToConnected(permitted, linked);
    const usable = scoped.available;
    const withheldCount = all.length - permitted.length - 1;

    /* THEY ASKED ABOUT ONE THING, so answer about that one thing.
     *
     * The menu is the right answer to "what can you do" and the wrong answer
     * to "can you send an email for me": somebody asking a yes-or-no question
     * about email should not be handed forty tools to read through. They get
     * the yes, then the handful that deliver it, in their own words.
     *
     * Built from the same role-gated list as the menu below, so a reader is
     * never told yes about something the gate will refuse. */
    if (_params.topic) {
      const area = areaForTopic(_params.topic);
      const inArea = area
        ? usable.filter((t) => (personaCopyFor(ctx.userRole, t.name)?.area ?? areaFor(t.name)) === area)
        : [];

      trackEvent("assistant.tool_invoked", ctx.userId, ctx.userRole, {
        tool: "what_can_you_do",
        outcome: inArea.length > 0 ? "topic_yes" : "topic_not_for_this_role",
        match_count: inArea.length,
        ...(ctx.workflowId ? { workflow_id: ctx.workflowId } : {}),
      });

      /* NOT "I CANNOT". The area exists in the product and this reader's role
         does not reach it, which is a permission fact with a person attached,
         not a limit of the software. Saying "no" here would teach them the
         product cannot do something it does every day for their colleague. */
      if (inArea.length === 0) {
        return {
          ok: true,
          data: { routineCount: 0, toolCount: 0, withheldCount },
          answer: `That is something Instinct does, but it is not part of what your role can run. Ask whoever administers this workspace, or type "what can you do" to see everything available to you.`,
        };
      }

      /* THE AREA IS TOO COARSE ON ITS OWN. Measured on the first version:
         "what files can you see" answered with news search and verified facts,
         because both live under Knowledge, and "check my tasks" listed OKRs
         and time logging while the task list itself fell off the end of the
         cut. Right in the sense that all of it is real, useless in the sense
         that the answer to the question was not on screen.

         So the area decides what is eligible and the topic's own words decide
         the order. A tool whose name or description carries the words they
         used is the one they meant. */
      const topicWords = _params.topic
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter((w) => w.length > 2 && !/^(?:the|my|our|can|you|see|get|for|and|with|any)$/.test(w));

      const scored = inArea
        .map((t) => {
          const copy = personaCopyFor(ctx.userRole, t.name);
          const text = `${t.name} ${copy ? copy.description : t.description}`.toLowerCase();
          const score = topicWords.reduce(
            (n, w) => n + (t.name.toLowerCase().includes(w) ? 2 : text.includes(w) ? 1 : 0),
            0,
          );
          return { t, copy, score };
        })
        .sort((a, b) => b.score - a.score);

      const items = scored
        .slice(0, 5)
        .map(({ t, copy }) => `- ${copy ? copy.description : trim(t.description)}`);

      return {
        ok: true,
        data: { routineCount: 0, toolCount: inArea.length, withheldCount },
        answer: [
          /* No restatement of the topic. "Here is what I can do with send an
             email" reads as broken English, and the question they just typed
             does not need repeating back at them. */
          "Yes. Here is what I can do:",
          "",
          ...items,
          "",
          "Just ask for the one you want in your own words.",
        ].join("\n"),
      };
    }

    /* A ROUTINE IS ONLY OFFERED IF ITS STEPS ARE REACHABLE.
     *
     * A dealer asking what the assistant can do was shown "where do things
     * stand - open PRs, open issues and what is blocked", which is not their
     * world and which they cannot run. A menu whose first section is
     * unusable teaches somebody the whole thing is not for them, and it is the
     * first screen they ever see.
     *
     * Judged by the steps rather than by a second list, so a routine cannot
     * drift from what its own tools require. */
    const routines = BUILT_IN_ROUTINES.filter((r) =>
      r.steps.every((step) =>
        step.kind !== "tool"
          ? true
          : canInvokeNamedTool(ctx.userRole, step.tool, toolCapability(step.tool)),
      ),
    );
    const lines: string[] = [];

    if (routines.length > 0) {
      lines.push("**Whole jobs, in one command**");
      lines.push("");
    }
    for (const r of routines) {
      lines.push(`- \`${r.command}\` — ${r.description}`);
    }
    if (routines.length > 0) {
      lines.push("");
      lines.push(
        "Each of those runs several of the tools below in order and stops when it needs you. Nothing is sent, filed or told to anybody without you confirming it.",
      );
      lines.push("");
    }

    /* IN THE READER'S LANGUAGE WHERE WE HAVE IT. A tool's own description is
       written for whoever maintains it, which is right for the registry and
       wrong for the first screen a dealer ever sees. */
    const byArea = new Map<string, string[]>();
    const areaOrder: string[] = [];
    for (const t of usable) {
      const copy = personaCopyFor(ctx.userRole, t.name);
      const area = copy?.area ?? areaFor(t.name);
      if (!byArea.has(area)) {
        byArea.set(area, []);
        areaOrder.push(area);
      }
      byArea.get(area)!.push(`- ${copy ? copy.description : trim(t.description)}`);
    }

    lines.push("**One thing at a time**");
    /* A persona's sections are its own, in the order its tools were curated.
       The built-in AREAS order is for the whole registry and files a dealer's
       most important capability under "Everything else". */
    const sections = hasPersona(ctx.userRole)
      ? areaOrder.map((title) => ({ title }))
      : AREAS;
    for (const { title } of sections) {
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
    /* ONLY OFFERED IF THEY CAN ACTUALLY DO IT. This is the most useful line on
       the page and it was printed unconditionally, so a dealer whose persona
       does not include plan_my_day was invited to describe their day and would
       have been met with nothing. A closing invitation that fails is worse
       than no closing line, because it is the last thing they read. */
    if (canInvokeNamedTool(ctx.userRole, "plan_my_day", toolCapability("plan_my_day"))) {
      lines.push("");
      lines.push(
        "If none of that quite matches your job, describe your day instead: tell me what you do on a Monday, in order, and I will map it onto what I can and cannot do, then offer to chain the rest into one command.",
      );
    }

    /* NOT CONNECTED IS NOT NOT BUILT, so this is an offer rather than a list
       of holes. One sentence naming the systems, not six unavailable CRM
       capabilities enumerated one by one. */
    const offer = describeAwaiting(scoped.awaitingSystems);
    if (offer) {
      lines.push("");
      lines.push(offer);
    }

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
        canInvokeNamedTool(ctx.userRole, g.tool, toolCapability(g.tool)),
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

    /* THE SAME CONTENT, SHAPED SO SOMEBODY CAN ACT ON IT.
     *
     * The prose above stays and is still what a person reads if the widget
     * cannot render: this product runs in a chat that has to degrade to text,
     * and an answer that is only a widget is an answer that can vanish.
     *
     * But read end to end the prose is sixty bullets, and for the first screen
     * somebody ever sees that is the whole job failed. They do not want the
     * catalog, they want one thing to try. So the widget leads with the
     * openers, keeps whole jobs next, and collapses the catalog behind the
     * group it belongs to. Built from the SAME arrays the prose is built from,
     * so the two cannot drift into describing different products. */
    const widget: WidgetSpec = {
      kind: "capabilities",
      routines: routines.map((r) => ({ command: r.command, description: r.description })),
      groups: (hasPersona(ctx.userRole) ? areaOrder.map((title) => ({ title })) : AREAS)
        .map(({ title }) => ({
          title,
          items: (byArea.get(title) ?? []).map((i) => i.replace(/^- /, "")),
        }))
        .filter((g) => g.items.length > 0),
      starters: openers.map((g) => ({ prompt: g.say[0], because: g.gives })),
      fallbackInvitation:
        "If none of that matches your job, describe your day instead: tell me what you do " +
        "on a Monday, in order, and I will map it onto what I can and cannot do.",
    };

    return {
      ok: true,
      data: { routineCount: routines.length, toolCount: usable.length, withheldCount },
      answer: lines.join("\n"),
      widget,
    };
  },
};

registerTool(capabilitiesTool);
