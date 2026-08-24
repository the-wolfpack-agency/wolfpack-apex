/**
 * get_goals tool — wraps runGoalsLookup().
 *
 * Answers questions of the form:
 *   "What are our OKRs?"
 *   "Show me our goals"
 *   "What's the north-star metric?"
 *   "How are we doing on our objectives?"
 */

import { z } from "zod";
import { runGoalsLookup, type GoalsLookupResult } from "./goals-lookup";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";

const ParamSchema = z.object({});
type Params = z.infer<typeof ParamSchema>;

const PATTERNS: RegExp[] = [
  /\bwhat\s+are\s+(?:our|the|my)\s+okrs?\b/i,
  /\b(?:show|tell)\s+me\s+(?:our|the|my)\s+(?:goals|okrs|objectives|targets)\b/i,
  /\bwhat'?s\s+(?:our|the)\s+north[\s-]?star\b/i,
  /\bhow\s+are\s+we\s+doing\s+on\s+(?:our|the|my)\s+(?:goals|okrs|objectives)\b/i,
  /\b(?:current|active)\s+(?:goals|okrs|objectives)\b/i,
  /\bnorth[\s-]?star\s+metric\b/i,
  /* Swept 2026-08-24: four of five ordinary phrasings missed, including
     "what are our goals", which is the plainest possible way to ask.
     Every pattern above wanted either the acronym OKR or the verb show.
     Goal, objective and target are the nouns; "are we on target" and
     "what did we say we would do" are how somebody asks without using
     any of them. */
  /\bwhat\s+are\s+(?:our|the|my)\s+(?:goals|objectives|targets)\b/i,
  /\bhow\s+are\s+we\s+tracking\s+(?:against|on)\b/i,
  /\bare\s+we\s+on\s+(?:target|track)\b/i,
  /\bwhat\s+did\s+we\s+say\s+we\s+(?:would|d)\s+do\b/i,
];

function matchGoalsIntent(message: string): Params | null {
  const trimmed = message.trim();
  for (const re of PATTERNS) {
    if (re.test(trimmed)) return {};
  }
  return null;
}

export const getGoalsTool: ToolDef<Params, GoalsLookupResult> = {
  name: "get_goals",
  description:
    "Retrieve the active OKRs, key results, and the latest North-Star metric snapshot.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent: matchGoalsIntent,
  async handler(_params, _ctx): Promise<ToolResult<GoalsLookupResult>> {
    try {
      const result = await runGoalsLookup();
      if (!result) {
        const empty = {
          northStar: null,
          okrs: [],
          answer: "no_goals",
          source: "goals" as const,
        };
        return {
          ok: true,
          data: empty as unknown as GoalsLookupResult,
          answer:
            "No OKRs or North-Star metric set yet. Once the team defines them in /goals, this answer will show them.",
        };
      }
      return { ok: true, data: result, answer: result.answer };
    } catch (err) {
      return {
        ok: false,
        code: "internal",
        message: `get_goals error: ${(err as Error)?.message ?? "unknown"}`,
      };
    }
  },
};

registerTool(getGoalsTool);
