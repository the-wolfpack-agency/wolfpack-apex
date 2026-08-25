/**
 * plan_my_day — "here is what I do on a Monday", answered.
 *
 * The front door. Somebody describes their own working day in their own words
 * and gets it back as a play by play: what the product can already do, what is
 * theirs alone, what has nothing behind it yet, and an offer to chain the rest
 * into one command.
 *
 * WHY THIS IS THE RIGHT ENTRY POINT
 *
 * Every other route in asks the person to translate their job into our
 * vocabulary first: browse a tool list, read a menu, learn what a routine is.
 * That translation is the work the product is supposed to be doing for them,
 * and asking them to do it is how software with real capability goes unused.
 *
 * COST
 *
 * One cheap model call, and only for the thing rules cannot do: splitting prose
 * into discrete steps. The mapping from a step to a tool is deterministic and
 * verified against the live registry, so a model can never put a name into a
 * plan that the product cannot honour.
 */
import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool, getTools } from "./registry";
import { canInvokeTool } from "./gate";
import { getAIClient } from "@/lib/ai/router";
import {
  buildExtractionPrompt,
  parseExtraction,
  mapDay,
  draftRoutine,
  renderPlan,
} from "@/lib/assistant/routines/day-plan";
import { savePendingAction, REVIEWABLE_PENDING_TTL_MINUTES } from "./pending-actions";
import type { ToolDef, ToolResult } from "./types";

const ParamSchema = z.object({
  /** Their description, in their words. */
  description: z.string().min(20).max(4000),
});
type Params = z.infer<typeof ParamSchema>;

interface PlanData {
  stepCount: number;
  covered: number;
  humanOnly: number;
  gaps: number;
  canChain: boolean;
}

/* Needs BOTH an invitation to plan and enough text to plan from. A short
   "my day" must not spend a model call on three words. */
/* "HERE IS" AND "HERE'S" ARE THE SAME SENTENCE. This read here'?s?, which
   cannot span the space in "here is", so "here is what I do each Monday" was
   not a day description and "here's what I do each Monday" was. Nobody types
   with that distinction in mind, and the half that missed fell through to the
   CRM search, which answered a description of somebody's morning with a
   record list.

   AND NOBODY ANNOUNCES THAT THEY ARE ABOUT TO DESCRIBE THEIR DAY. Every
   opener above is an invitation - "here is what I do", "walk you through my
   day". People just start: "every morning I read my email, check the calendar
   and chase the overnight leads". That is the single most useful thing anybody
   can type at this product and it reached a model.

   THE SEQUENCE IS THE DISCRIMINATOR, not the opener. "every morning I check
   the CRM" is a remark; a chain is a LIST, so the bare form below additionally
   requires a comma or a "then". That keeps the widening from swallowing
   ordinary sentences that happen to begin with "every day I", which is the
   failure this file already warns about in the capability matcher above. */
const DAY_OPENER =
  "here(?:'?s|\\s+is)?\\s+what\\s+i\\s+do" +
  "|this\\s+is\\s+what\\s+i\\s+do" +
  "|my\\s+(?:typical\\s+|usual\\s+)?(?:day|monday|morning)\\s+(?:looks?\\s+like|is|goes)" +
  "|walk(?:ing)?\\s+you\\s+through\\s+my\\s+day" +
  "|plan\\s+my\\s+day" +
  "|map\\s+my\\s+day";

/** Somebody describing a routine without announcing it, as a sequence. */
const BARE_ROUTINE =
  "(?:every|each)\\s+(?:morning|day|monday|week|afternoon)\\b[^.?!]*?\\bi\\s+\\w+" +
  /* TWO SEPARATORS, NOT ONE. A single comma is how somebody complains:
     "every day I have to log in again, the session expires". Requiring one was
     enough to claim three bug reports out of four, and a bug report answered
     with a planning exercise is the worst possible response to somebody
     telling you the product is broken - it is the moment their words matter
     most, and feedback is the tool that must get them.
     A described day is a LIST, so it carries at least two: "read my email,
     check the calendar and chase the leads". */
  "(?:[^.?!]*?(?:,|\\bthen\\b|\\band\\b)){2}";

const INTENT_RE = new RegExp(`\\b(?:${DAY_OPENER}|${BARE_ROUTINE})`, "i");

/* A QUESTION IS NOT A DESCRIPTION.
   "what does my day look like tomorrow" wants a calendar, and answering it with
   a planning exercise is both a wasted model call and a person told about
   themselves when they asked about their diary. Checked on the opening words
   rather than on a trailing question mark, because plenty of people do not
   punctuate. */
const QUESTION_OPENER = /^(?:what|when|where|who|why|how|is|are|does|do|did|can|could|will|would|should)\b/i;

export function matchPlanDayIntent(message: string): Params | null {
  const text = message.trim();
  if (text.length < 40 || text.length > 4000) return null;
  if (QUESTION_OPENER.test(text)) return null;
  return INTENT_RE.test(text) ? { description: text } : null;
}

export const planMyDayTool: ToolDef<Params, PlanData> = {
  name: "plan_my_day",
  description:
    "Take a description of somebody's working day and say back which steps the product can already do, which are theirs alone, and where there is nothing yet.",
  capability: "*",
  paramSchema: ParamSchema,
  matchIntent: matchPlanDayIntent,
  async handler(params, ctx): Promise<ToolResult<PlanData>> {
    /* The manifest offered to the model is already filtered to what this person
       may run. A tool they cannot invoke should never be proposed and then
       withdrawn: that is a worse experience than never mentioning it. */
    const tools = getTools().filter(
      (t) => canInvokeTool(ctx.userRole, t.capability) && t.name !== "plan_my_day",
    );

    let raw = "";
    try {
      const res = await getAIClient().complete({
        messages: [{ role: "user", content: buildExtractionPrompt(params.description, tools) }],
        max_tokens: 900,
        /* Splitting prose into steps is not a reasoning problem. */
        model_tier: "cheap",
        metadata: {
          feature: "assistant.plan_my_day",
          user_id: ctx.userId,
          user_role: ctx.userRole,
          ...(ctx.workspaceId ? { workspace_id: ctx.workspaceId } : {}),
        },
      });
      raw = res.content;
    } catch {
      return {
        ok: false,
        code: "internal",
        message:
          "I could not work through that just now. Try again in a moment, or walk me through the day one step at a time.",
      };
    }

    const described = parseExtraction(raw);
    const plan = mapDay(described, tools, ctx.userRole);
    const draft = draftRoutine(plan, "from_your_day", "run my day");

    /* THE OFFER HAS TO LEAD SOMEWHERE.
     *
     * The draft is held as a pending action so the person's "yes" saves it,
     * through the confirm-or-cancel path every other action in the product
     * already uses. Reusing it means "no" also works, and means this cannot
     * become a second, subtly different way to agree to something.
     *
     * Nothing is written yet. A plan is a description of somebody's day, and
     * quietly keeping a routine they have not agreed to would be the product
     * deciding for them at exactly the moment it is asking. */
    /* ONLY OFFER WHAT THE "YES" CAN REACH.
     *
     * This swallowed the result, so the offer went out whether or not anything
     * had been written to answer it with. Somebody read their day back, said
     * yes, and got "I have lost the thread on what you are saying yes to" —
     * which is the assistant blaming the conversation for its own failed
     * write. Rendering the question is now conditional on the row existing. */
    let offerIsLive = false;
    if (draft) {
      const pending = await savePendingAction({
        userId: ctx.userId,
        toolName: "save_routine",
        params: { routine: draft, workspaceId: ctx.workspaceId ?? "default" },
        description: `Save the chain from the day you described as "${draft.command}"`,
        /* They are about to read a dozen steps before answering. */
        ttlMinutes: REVIEWABLE_PENDING_TTL_MINUTES,
      }).catch(() => ({ saved: false }));
      offerIsLive = pending.saved;
    }

    trackEvent("assistant.tool_invoked", ctx.userId, ctx.userRole, {
      tool: "plan_my_day",
      steps: plan.steps.length,
      covered: plan.covered,
      human_only: plan.humanOnly,
      /* WHAT PEOPLE DESCRIBE THAT WE CANNOT DO, counted per run. Over a few
         weeks this is the most direct statement of what to build next that the
         product can produce: it is a list of real work, from real people,
         ranked by how often it comes up. */
      gaps: plan.gaps,
      ...(ctx.workflowId ? { workflow_id: ctx.workflowId } : {}),
    });

    return {
      ok: true,
      data: {
        stepCount: plan.steps.length,
        covered: plan.covered,
        humanOnly: plan.humanOnly,
        gaps: plan.gaps,
        canChain: offerIsLive,
      },
      answer: renderPlan(plan, offerIsLive),
    };
  },
};

registerTool(planMyDayTool);
