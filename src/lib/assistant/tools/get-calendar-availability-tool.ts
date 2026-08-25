/**
 * get_calendar_availability tool — wraps runCalendarAvailability().
 *
 * Answers questions of the form:
 *   "Am I free Thursday?"
 *   "When is <person> available this week?"
 *   "Is <person> busy tomorrow?"
 *   "What's on my calendar today?"
 *
 * Calls into the existing zero-token calendar-availability handler.
 * Reads the requesting user's delegated Microsoft Graph token for
 * self queries; resolves a directory lookup for "<person>" queries.
 */

import { z } from "zod";
import {
  runCalendarAvailability,
  type CalendarAvailabilityResult,
} from "./calendar-availability";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";

const ParamSchema = z.object({
  personName: z.string().min(1).max(80).optional(),
  timeframe: z.string().min(2).max(40).optional(),
  isSelfQuery: z.boolean().optional(),
});
type Params = z.infer<typeof ParamSchema>;

const SELF_PATTERNS: RegExp[] = [
  /\b(?:am\s+i|are\s+we)\s+(?:free|busy|available)\s+(?:on\s+|at\s+)?(.{2,40}?)\??$/i,
  /* Accepts both contractions ("what's") and the spelled-out form
     ("what is"); welcome-modal chips use the latter so they read
     well as buttons. Both forms route to the same handler. */
  /\bwhat(?:'?s|\s+is)\s+on\s+my\s+(?:calendar|schedule|agenda)\s*(?:for|on)?\s*(.{2,40})?\??$/i,
  /\bdo\s+i\s+have\s+(?:any\s+)?(?:meetings|events)\s+(?:on|today|tomorrow|this\s+week)?\s*(.{2,40})?\??$/i,
  /* "what meetings do I have on Monday" / "any meetings tomorrow" /
     "my meetings next week" — leading-noun phrasing the previous
     three patterns missed. Captures the timeframe tail after the
     optional preposition. */
  /\b(?:what|any)\s+(?:meetings|events)\s+(?:do\s+i\s+have\s+)?(?:on\s+|for\s+)?(.{2,40}?)\??$/i,
  /\bmy\s+(?:meetings|events|schedule|calendar)\s+(?:on\s+|for\s+|this\s+|next\s+|last\s+)?(.{2,40}?)\??$/i,
  /* Bare-keyword shortcut: "Calendar Monday", "schedule Tuesday".
     The leading word is the page name (already filtered out by
     shouldBypassKnowledgeCache); the trailing token is the day. */
  /^(?:calendar|schedule|agenda)\s+(.{2,40}?)\??$/i,
];

const PERSON_PATTERNS: RegExp[] = [
  /\bis\s+(?<name>[A-Z][\w. -]{1,40}?)\s+(?:free|busy|available)\s+(?:on\s+|at\s+)?(?<tf>.{2,40}?)\??$/i,
  /\bwhen\s+is\s+(?<name>[A-Z][\w. -]{1,40}?)\s+(?:free|available|next\s+available)\s*(?<tf>.{2,40})?\??$/i,
  /\bwhat'?s\s+(?<name>[A-Z][\w. -]{1,40}?)'?s?\s+(?:calendar|schedule)\s+(?:for|on)?\s*(?<tf>.{2,40})?\??$/i,
];

function matchCalendarIntent(message: string): Params | null {
  const trimmed = message.trim();
  for (const re of SELF_PATTERNS) {
    const m = re.exec(trimmed);
    if (m) {
      const tf = (m[1] ?? "").trim().replace(/[?.!]+$/g, "");
      return { isSelfQuery: true, timeframe: tf || "this week" };
    }
  }
  for (const re of PERSON_PATTERNS) {
    const m = re.exec(trimmed);
    if (m?.groups?.name) {
      return {
        personName: m.groups.name.trim().replace(/[?.!]+$/g, ""),
        timeframe: (m.groups.tf ?? "").trim().replace(/[?.!]+$/g, "") || "this week",
        isSelfQuery: false,
      };
    }
  }
  return null;
}

export const getCalendarAvailabilityTool: ToolDef<Params, CalendarAvailabilityResult> = {
  name: "get_calendar_availability",
  description:
    "Look up free/busy / what's scheduled on a calendar. Works for the requesting user OR a named teammate.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent: matchCalendarIntent,
  async handler(params, ctx): Promise<ToolResult<CalendarAvailabilityResult>> {
    /* A CALENDAR STEP WITH NOBODY NAMED IS YOUR OWN CALENDAR.
     *
     * This tool has two modes and, called with nothing, did neither: no name
     * to look up and no self-user to fall back on. It answered "I couldn't
     * find calendar info for that person" about a person nobody had mentioned.
     *
     * Which is exactly what a drafted chain hands it. A step built from
     * "check my calendar" carries no parameters on purpose - a guessed
     * parameter is a wrong action taken confidently - and the schema lets it
     * through because every field here is optional. So the first step of the
     * first chain somebody built for themselves failed, and failed in a way
     * that read as the product not knowing who they were.
     *
     * An explicit isSelfQuery still wins in both directions, so asking about a
     * named person is untouched. */
    const isSelf = params.isSelfQuery ?? !(params.personName ?? "").trim();

    try {
      const result = await runCalendarAvailability({
        personName: params.personName ?? "",
        timeframeToken: params.timeframe,
        selfUser: isSelf
          ? { userId: ctx.userId, displayName: ctx.userEmail ?? ctx.userId }
          : undefined,
      });
      if (!result) {
        return {
          ok: true,
          data: { busy: [], free: [], notes: "no_data" } as unknown as CalendarAvailabilityResult,
          answer: isSelf
            ? "I couldn't read your calendar. You may need to grant Microsoft Calendar access in Settings."
            : `I couldn't find calendar info for ${params.personName ?? "that person"}.`,
        };
      }
      const ans =
        (result as { answer?: string }).answer ??
        "I checked the calendar but don't have a summary to share.";
      return { ok: true, data: result, answer: ans };
    } catch (err) {
      return {
        ok: false,
        code: "internal",
        message: `get_calendar_availability error: ${(err as Error)?.message ?? "unknown"}`,
      };
    }
  },
};

registerTool(getCalendarAvailabilityTool);
