/**
 * Draft, check, improve, ship.
 *
 * WHAT THIS ADDS THAT THE ROUTER DID NOT HAVE. verifyAnswer applies free rules
 * and judgeAnswer asks a model whether an answer is sound. Neither can make an
 * answer better: when they fail, the router asks a LARGER model the original
 * question again, pays full price for a second attempt, and throws the first
 * away including the parts that were right.
 *
 * Most of what a small model gets wrong is an edit, not a rewrite - a missing
 * caveat, an unanswered half of a two-part question, a claim it should not have
 * made. So a reviewer gets the question and the draft and returns either SHIP
 * or a correction.
 *
 * WHY THIS IS THE ARGUMENT FOR THE ROUTER, not a feature beside it. A cheap
 * model plus a cheap review costs a fraction of a premium call and is checkable
 * in a way a single premium call is not: two models from different families had
 * to agree, and the disagreement is recorded. That is a stronger claim than
 * "we used the best model", and it is only available to something that can
 * address several models at once.
 *
 * COST DISCIPLINE. The free rules run first and the reviewer is only asked when
 * they are unsatisfied or the caller insists. Reviewing every answer would
 * double the bill to re-approve answers that were already fine.
 *
 * INDEPENDENCE. The reviewer should come from a different family than the
 * draft. A model reviewing its own output agrees with itself, which produces an
 * audit row that means nothing. Selection is the caller's to make - see
 * chooseIndependentJudge - and this records which model actually reviewed so
 * the claim can be checked later rather than assumed.
 */
import { fenceUntrusted } from "@/lib/ai/provenance";
import { ANSWER_IMPROVE } from "@/lib/prompts/definitions/answer-improve";

export const IMPROVE_SYSTEM = ANSWER_IMPROVE.render({});
export const IMPROVE_MAX_TOKENS = 700;

export interface ImproveResult {
  /** The answer to send. The draft unless the reviewer replaced it. */
  answer: string;
  /** True when the reviewer supplied a correction. */
  changed: boolean;
  /** False when no reviewer could be reached, so the draft passed unchecked.
   *  "checked and fine" and "not checked" must never look alike. */
  reviewed: boolean;
  /** Short note for the audit row. Never the draft itself. */
  reason: string;
}

export function buildImprovePrompt(question: string, draft: string): string {
  return fenceUntrusted([
    { provenance: "external", label: "question", text: question },
    { provenance: "retrieved", label: "draft answer", text: draft },
  ]).text;
}

/**
 * Read one reply without trusting its shape.
 *
 * A reviewer that answers in prose instead of the two forms it was given has
 * not reviewed anything usable, and treating its prose as a corrected answer
 * would replace a checked draft with an unchecked ramble. Anything unparseable
 * ships the draft and says it was unreviewed.
 */
export function parseImproveReply(raw: string, draft: string): ImproveResult {
  const text = (raw ?? "").trim();
  if (!text) {
    return { answer: draft, changed: false, reviewed: false, reason: "reviewer returned nothing" };
  }
  if (/^ship\b/i.test(text)) {
    return { answer: draft, changed: false, reviewed: true, reason: "reviewer approved the draft" };
  }
  const fix = /^fix:\s*([\s\S]+)$/i.exec(text);
  if (fix && fix[1].trim().length > 0) {
    return {
      answer: fix[1].trim(),
      changed: true,
      reviewed: true,
      reason: "reviewer corrected the draft",
    };
  }
  return {
    answer: draft,
    changed: false,
    reviewed: false,
    reason: "reviewer replied in neither form; draft shipped unchanged",
  };
}

/**
 * Review one draft. NEVER THROWS: a reviewer that cannot be reached must cost
 * the check, never the answer. The caller is told which happened.
 */
export async function reviewAndImprove(
  question: string,
  draft: string,
  complete: (input: { system: string; prompt: string; maxTokens: number }) => Promise<string>,
): Promise<ImproveResult> {
  if (!question.trim() || !draft.trim()) {
    return { answer: draft, changed: false, reviewed: false, reason: "nothing to review" };
  }
  try {
    const raw = await complete({
      system: IMPROVE_SYSTEM,
      prompt: buildImprovePrompt(question, draft),
      maxTokens: IMPROVE_MAX_TOKENS,
    });
    return parseImproveReply(raw, draft);
  } catch (err) {
    return {
      answer: draft,
      changed: false,
      reviewed: false,
      reason: `reviewer unreachable: ${(err as Error).message.slice(0, 80)}`,
    };
  }
}
