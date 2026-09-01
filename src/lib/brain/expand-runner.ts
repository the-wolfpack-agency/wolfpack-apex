/**
 * The rewriter the retrieval path has always accepted and never been given.
 *
 * expand-query.ts holds the decision, the prompt and the parser. retrieve.ts
 * calls the rewriter, keeps whichever attempt did better, and records the
 * original question either way. All of it correct, all of it tested, and all
 * of it dead in production: the assistant calls retrieve with no expander, so
 * the branch that would use one returns before it is reached. Only the eval
 * script ever supplied it.
 *
 * WHAT THAT COSTS, MEASURED. "Do we pay half now and half later?" was asked
 * five times by people and answered none of them, while the work order that
 * answers it says fifty per cent on execution and the remainder on delivery.
 * Its embedding scores below the semantic floor entirely: zero hits, not a
 * near miss. No amount of ranking reaches a paragraph that shares no words
 * with the question, which is the case this module was written for and never
 * got to handle.
 *
 * IT ONLY RUNS ON A THIN FIRST PASS. retrieve.ts asks shouldExpand before
 * calling this, so an ordinary question that found its answer never pays for
 * a second thought. That is the whole cost argument and it is enforced above
 * this file rather than inside it.
 *
 * CHEAP TIER, AND SIXTY TOKENS. Rewriting a question into document vocabulary
 * is not a reasoning problem. Paying a premium model to produce eight words
 * is how a feature that rescues a failed answer becomes a line item somebody
 * cancels.
 */

import { getAIClient } from "@/lib/ai";
import { EXPANSION_SYSTEM, EXPANSION_MAX_TOKENS, parseExpansion } from "./expand-query";

export interface ExpandContext {
  userId: string;
  userRole: string;
  workspaceId?: string;
}

/**
 * Build the rewriter to hand to retrieve().
 *
 * Returns the original question on any failure. A rewrite is an optimization
 * on a question that already failed, so a provider outage during one must
 * cost the reader nothing beyond the answer they were not getting anyway,
 * and retrieve() treats an unchanged question as "do not bother retrying".
 */
export function makeExpander(ctx: ExpandContext): (question: string) => Promise<string> {
  return async (question: string) => {
    try {
      const res = await getAIClient().complete({
        messages: [
          { role: "system", content: EXPANSION_SYSTEM },
          { role: "user", content: question },
        ],
        max_tokens: EXPANSION_MAX_TOKENS,
        model_tier: "cheap",
        /* The question goes through the same redaction and budget every other
           call does. A rewrite is still a prompt leaving the building. */
        sensitivity: "pii",
        metadata: {
          feature: "brain.query_expansion",
          user_id: ctx.userId,
          user_role: ctx.userRole,
          ...(ctx.workspaceId ? { workspace_id: ctx.workspaceId } : {}),
        },
      });
      return parseExpansion(res.content ?? "", question);
    } catch {
      /* silent-ok: returning the original is the documented way to say "do not
         retry", retrieve() checks for exactly that, and the turn continues
         with the answer it already had. Nothing is lost that was not already
         lost when the first pass came back thin. */
      return question;
    }
  };
}
