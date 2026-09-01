/**
 * "ok, do that".
 *
 * Driving the deployed assistant through four turns of a plausible first
 * conversation, three of them failed, and this was the worst:
 *
 *   > I look after warranty claims for three dealerships. what would you
 *     do first?
 *   < That tool (get_financials_metric) needs a higher-privilege role.
 *   > ok, do that
 *   < Here's what the brain has on this: BA101 Mobile Coach Rules.csv
 *     (chunk 4) > go. afterall,"" 20,a. 1. letsgo. 5. new...
 *
 * "ok, do that" carries no subject. It was dispatched as if it were a
 * fresh question, matched nothing, fell through to document retrieval,
 * and returned a chunk of an unrelated spreadsheet with complete
 * confidence. That is the difference between a chat and a search box, and
 * it is also the thing standing between us and a chain somebody can start
 * by agreeing to it.
 *
 * THE RULE. A turn that refers to the previous one is resolved against
 * the previous one, or it asks. It is never dispatched as a new question,
 * because a message with no subject cannot match a tool honestly and
 * every path after that point is a guess.
 */

/**
 * Turns that mean "the thing you just said", and nothing else.
 *
 * Deliberately narrow. A false positive here re-runs the last offer
 * instead of answering what somebody asked, so anything carrying its own
 * subject must fall through: "do that for the Detroit store" is a new
 * question with a new object in it, and only bare agreement qualifies.
 */
const FOLLOW_THROUGH_RE =
  /^(?:ok(?:ay)?|yes|yep|yeah|sure|please|go ahead|do it|do that|run it|run that|let'?s do it|sounds good|perfect|great)\b[\s,.!]*(?:do (?:that|it|so)|run (?:that|it)|go ahead|please)?[\s,.!]*$/i;

/** The longest a bare acknowledgement can plausibly be. */
const MAX_FOLLOW_THROUGH_CHARS = 40;

export function isFollowThrough(message: string): boolean {
  const m = message.trim();
  if (m.length === 0 || m.length > MAX_FOLLOW_THROUGH_CHARS) return false;
  return FOLLOW_THROUGH_RE.test(m);
}

/**
 * The command the assistant last put in front of somebody.
 *
 * Our answers offer things in backticks, which is what makes this
 * possible without a model: `run my morning`, `where do things stand`.
 * The first one is the offer, because that is the order they were
 * presented in and the order a person reads.
 *
 * A refusal is not an offer. "That tool needs a higher-privilege role"
 * names a tool in the sentence, and agreeing with it must not run the
 * thing that was just denied.
 */
const REFUSAL_RE =
  /\b(needs a higher-privilege role|not authorized|not authorized|don'?t have a confident answer|isn'?t configured|no .* connected)\b/i;

export function extractOffer(assistantText: string): string | null {
  if (!assistantText) return null;
  if (REFUSAL_RE.test(assistantText)) return null;
  for (const m of assistantText.matchAll(/`([^`\n]{3,60})`/g)) {
    const candidate = m[1].trim();
    /* A path or a code identifier is not something to say back. */
    if (candidate.startsWith("/") || /[_(){};=]/.test(candidate)) continue;
    return candidate;
  }
  return null;
}

export interface FollowThroughResolution {
  /** Dispatch this instead of the bare acknowledgement. */
  rewritten?: string;
  /** Nothing was on offer: say so rather than guessing. */
  clarify?: string;
}

/**
 * What to do with a bare acknowledgement.
 *
 * When the previous turn offered something, agreeing to it runs it. When
 * it did not, the honest answer is to say what was on the table, which is
 * nothing. Falling through to retrieval was how a spreadsheet chunk ended
 * up being presented as the answer to "ok, do that".
 */
export function resolveFollowThrough(
  previousAssistantText: string | null | undefined,
): FollowThroughResolution {
  const offer = extractOffer(previousAssistantText ?? "");
  if (offer) return { rewritten: offer };
  return {
    clarify:
      "I want to make sure I carry on with the right thing, and I did not offer " +
      "anything specific just now. Tell me what to run, or ask me what I can do " +
      "and I will list the chains you can start from here.",
  };
}

/**
 * The assistant's last turn in this conversation.
 *
 * Kept here rather than in the route so the whole behavior, including
 * where the previous turn comes from, is testable in one place. Returns
 * null on anything unexpected: a follow-through that cannot find its
 * antecedent asks, which is the same answer it gives when there was no
 * offer.
 */
/**
 * IS THIS "YES" ALREADY SPOKEN FOR?
 *
 * The conversation layer has its own confirmation handling and has had it
 * for far longer: a write tool that asks before it acts, a routine that
 * stops for an answer, a template offering to be adopted. All three end
 * with the product telling somebody to say yes.
 *
 * Resolving follow-through in the ROUTE put a second reader of the word
 * "yes" in front of all of them. Driving the deployed assistant found it
 * immediately, on the one flow that says the word out loud:
 *
 *   < look at the week ahead would run 5 steps and stop for you at one of
 *     them. Say yes and it becomes a command you can type.
 *   > yes
 *   < I want to make sure I carry on with the right thing, and I did not
 *     offer anything specific just now.
 *
 * It had offered something specific. It had asked for exactly that word.
 * The offer simply was not in backticks, and a second reader that cannot
 * see the first one's offers will always eventually contradict it.
 *
 * So the route now steps aside whenever something downstream is already
 * waiting for an answer. Follow-through is for the case where nothing is
 * pending and a bare "ok, do that" would otherwise be dispatched as a
 * fresh question, which is the gap it was written for and the only gap it
 * should fill.
 */
export async function somethingIsAlreadyWaiting(
  userId: string,
  conversationId: string | null | undefined,
): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  try {
    const { query } = await import("@/lib/db");
    /* A pending action is the confirmation the write path is waiting on.
       Checked without consuming it: consuming here would answer the
       confirmation in the wrong layer and the action would never run. */
    const pending = await query<{ n: string }>(
      `SELECT COUNT(*)::bigint AS n
         FROM instinct_pending_actions
        WHERE user_id = $1
          AND consumed_at IS NULL
          AND expires_at > NOW()`,
      [userId],
    );
    if (Number(pending.rows[0]?.n ?? 0) > 0) return true;

    /* A routine stopped at a human step or an ask is also waiting, and
       the word it is waiting for is the same one. */
    if (conversationId) {
      const waiting = await query<{ n: string }>(
        `SELECT COUNT(*)::bigint AS n
           FROM assistant_routine_runs
          WHERE user_id = $1
            AND state = 'waiting_for_human'`,
        [userId],
      );
      if (Number(waiting.rows[0]?.n ?? 0) > 0) return true;
    }
    return false;
  } catch {
    /* Unreadable state means we do not know, and the safe answer to "may
       I take this yes" when we do not know is no. */
    return true;
  }
}

export async function lastAssistantMessage(
  conversationId: string | null | undefined,
): Promise<string | null> {
  if (!conversationId || !process.env.DATABASE_URL) return null;
  try {
    const { query } = await import("@/lib/db");
    const res = await query<{ content: string }>(
      `SELECT content FROM instinct_messages
        WHERE conversation_id = $1 AND role = 'assistant'
        ORDER BY created_at DESC
        LIMIT 1`,
      [conversationId],
    );
    return res.rows[0]?.content ?? null;
  } catch {
    return null;
  }
}
