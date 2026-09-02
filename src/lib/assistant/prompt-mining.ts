/**
 * Turn what people actually typed into safe corpus for the answer harness.
 *
 * WHY MINE AT ALL. The hand-written corpus is 36 phrasings we thought of. The
 * failures that reach a client are the ones we did not, and they are sitting in
 * brain_query_log, hundreds of distinct real prompts a month. Feeding those in
 * makes the harness grow toward what actually breaks, the same way the
 * retrieval eval draws its pairs from real documents rather than invented ones.
 *
 * WHY IT IS NOT AS SIMPLE AS SELECT query. Real prompts carry two hazards this
 * function exists to remove:
 *
 *   PII. People type card numbers, national-insurance numbers, emails. Measured
 *   on this workspace: "4332356789890077" and "employee NI number QQ123456C"
 *   are real queries. Writing those into a corpus file, or echoing them into a
 *   log, would take a user's sensitive data somewhere it was never meant to go.
 *   So a prompt is redacted, and if redaction found anything it is DROPPED
 *   rather than kept in a scrubbed form: a corpus of redacted PII is still a
 *   corpus built from people's PII, and a "[CREDIT_CARD_1]" prompt tests
 *   nothing anyway.
 *
 *   ACTIONS. Some prompts are not questions, they are instructions: "send this
 *   to Nick", "log this for HR", "upload the contract". The answer harness runs
 *   each prompt through the real assistant, so replaying one of those would
 *   fire a real send, a real write. Only read-only, question-shaped prompts are
 *   kept, and the action verbs are excluded explicitly rather than trusted to
 *   the question-shape check alone.
 *
 * Pure: it takes rows and returns safe prompts. The database read lives in the
 * caller, so this is testable without one and the safety rules are visible in
 * one place.
 */

import { redactText } from "@/lib/ai/redaction";


/**
 * A read request, not a fragment.
 *
 * Deliberately NOT the brain's isQuestionShaped, which is a narrower gate for
 * "is this a knowledge-base lookup" and rejects plain questions like "how much
 * did the printer cost". The harness wants anything a person asks the assistant
 * to READ back: it opens with an interrogative or a read verb, or it ends in a
 * question mark. A keyword dump like "policy time off" matches neither and is
 * left out, because the harness reads answers and a keyword has no answer to
 * read.
 */
const READ_QUESTION =
  /^(?:what|how|when|who|whom|whose|where|why|which|is|are|was|were|do|does|did|can|could|should|would|will|has|have|had|show|list|tell|give|find|search|remind|any)|\?\s*$/i;

/**
 * PII SHAPES redactText does not catch, because it prefers false negatives.
 *
 * Measured on this workspace: "4332356789890077" is a real query and is not
 * Luhn-valid, so the credit-card detector, which checks Luhn, passes it. And a
 * national-insurance number embedded in a sentence ("employee NI number
 * QQ123456C") is not caught either. Both are still someone's identifier and
 * must never reach a corpus file. So a card-shaped digit run and a
 * two-letters-six-digits id shape are dropped on sight, belt to redactText's
 * braces.
 */
const SENSITIVE_SHAPE = /\d[\d\s-]{10,}\d|[A-Za-z]{2}\d{6}/;

/** A prompt that would cause a side effect if replayed. Excluded, always. */
const ACTION_VERB =
  /\b(send|email|reply|forward|log|upload|create|add|schedule|book|assign|delete|remove|archive|draft|post|invite|rename|move|update|set|change|approve|revoke|pay|share)\b/i;

export interface MinedRow {
  query: string;
}

/**
 * Filter and clean real prompts into corpus safe to replay.
 *
 * Order is the safety story: drop anything carrying PII, then drop anything
 * that could act, then keep what is question-shaped, then dedupe. A prompt has
 * to clear every gate to survive.
 */
export function minePrompts(rows: MinedRow[], limit = 40): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const row of rows) {
    const q = (row.query ?? "").trim();
    if (q.length < 6 || q.length > 140) continue;

    /* PII: if redaction found anything at all, this prompt is out. Not
       scrubbed and kept: a corpus of redacted PII is a corpus built from
       people's PII, and the scrubbed form tests nothing real. */
    if (redactText(q).redacted) continue;
    /* And the shapes redaction's Luhn/boundary rules let through. */
    if (SENSITIVE_SHAPE.test(q)) continue;

    /* A prompt that could act is never replayed through the live assistant. */
    if (ACTION_VERB.test(q)) continue;

    /* What is left should be a read request, not a fragment or a keyword dump. */
    if (!READ_QUESTION.test(q)) continue;

    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if (out.length >= limit) break;
  }
  return out;
}
