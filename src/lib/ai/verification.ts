/**
 * Is this answer good enough to ship, and if not, what does it cost to fix?
 *
 * THE PROBLEM THIS SOLVES
 *
 * Routing to the cheapest capable model is only defensible if somebody checks
 * that the cheap model actually did the job. Every gateway routes; none of them
 * looks at what came back. So "we saved 80%" is asserted, and the first time a
 * small model returns something thin the saving is quietly paid for by whoever
 * read it.
 *
 * THE SHAPE THAT IS ACTUALLY CHEAPER
 *
 * A fixed cascade of five reviewers costs MORE than one large call. Running a
 * small model five times does not beat running a large one once, and a design
 * that always reviews has quietly bought the expensive option with extra steps.
 *
 * So verification is CONDITIONAL. The cheap model answers, deterministic checks
 * run for free, and a larger model is asked only when those checks say the
 * answer is not good enough. On the ordinary request the total cost is one
 * cheap call plus zero. On the request the cheap model fluffed, it is one cheap
 * call plus one good one, which is what a naive router would have spent anyway
 * while getting the worse answer.
 *
 * DETERMINISTIC FIRST, MODEL ONLY WHERE NECESSARY
 *
 * Every check here is a rule, not a judgement. That is deliberate and it is the
 * same doctrine as the rest of the gate: credentials are already stripped both
 * directions by redaction.ts, and a model that USUALLY notices a card number is
 * strictly worse than a rule that always does. These rules catch the failures a
 * rule can catch: nothing came back, the model refused, the answer stopped
 * mid-sentence, it answered a different question, it promised to do something
 * later instead of doing it.
 *
 * What a rule cannot judge is whether a correct-looking answer is CORRECT. That
 * is the one place a second model earns its cost, and it is deliberately not in
 * this module: this decides WHETHER to escalate, and the router decides what to
 * escalate to. Keeping the decision pure means the policy can be read, tested
 * and changed without touching the thing that spends money.
 */

/** Why an answer was judged insufficient. Stable strings; dashboards join on them. */
export type VerificationFlag =
  | "empty"
  | "truncated"
  | "refused"
  | "deferred"
  | "ignored_question"
  | "placeholder";

export interface VerificationVerdict {
  /** True when the answer can be shipped as it stands. */
  sufficient: boolean;
  /** Every rule that fired, in a stable order. */
  flags: VerificationFlag[];
  /** One sentence naming the problem, for the analytics row and the audit. */
  reason: string;
}

/**
 * Phrases a model uses when it declines. Matched at the START of the answer
 * only: an answer that discusses refusal ("the policy says we cannot share
 * salary data, however the published band is...") is a good answer, and
 * matching anywhere would throw it away and pay for a second opinion on it.
 */
const REFUSAL_OPENERS: readonly RegExp[] = [
  /^i(?:'m| am) (?:sorry|unable|not able)\b/i,
  /^i (?:can(?:'t|not)|won't) (?:help|assist|answer|provide|do)\b/i,
  /^(?:sorry|unfortunately),? (?:i|but i)\b/i,
  /^as an ai\b/i,
];

/**
 * Promising to do the work rather than doing it. A small model under-briefed
 * on a task reaches for this constantly, and it reads as progress until
 * somebody waits for the thing that is never coming.
 */
const DEFERRAL_PATTERNS: readonly RegExp[] = [
  /\bi(?:'ll| will) (?:get back to you|follow up|do that|start on|begin)\b/i,
  /\b(?:let me|i'll) (?:look into|check on) (?:that|this) and\b/i,
  /\bplease (?:hold|wait) while i\b/i,
];

/** Text a model leaves behind when it did not have the substance to finish. */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /\[(?:insert|your|todo|placeholder|xxx)[^\]]*\]/i,
  /\b(?:lorem ipsum|TBD|TODO:)\b/,
  /\{\{[a-z_]+\}\}/i,
];

/** Sentence-ending punctuation, closing quotes/brackets, or a code fence. */
const ENDS_CLEANLY = /(?:[.!?:]|["'”’)\]]|```|\|)\s*$/;

export interface VerificationInput {
  /** What came back from the model. */
  answer: string;
  /** What was asked, when the caller has it. Carried for the model-based
   *  relevance stage; no rule in this module reads it. */
  question?: string;
  /** Whether the caller expected a long answer. Short is only a problem when
   *  something substantial was requested. */
  minLength?: number;
}

/**
 * Judge an answer against rules. Pure: no network, no model, no database, so
 * the policy is readable and testable without spending anything.
 */
export function verifyAnswer(input: VerificationInput): VerificationVerdict {
  const answer = (input.answer ?? "").trim();
  const flags: VerificationFlag[] = [];

  if (answer.length === 0) {
    return { sufficient: false, flags: ["empty"], reason: "The model returned nothing." };
  }

  if (REFUSAL_OPENERS.some((re) => re.test(answer))) flags.push("refused");
  if (DEFERRAL_PATTERNS.some((re) => re.test(answer))) flags.push("deferred");
  if (PLACEHOLDER_PATTERNS.some((re) => re.test(answer))) flags.push("placeholder");

  /* Truncation, judged on how the text ENDS rather than on length. A model cut
     off mid-sentence is the failure that most often survives review, because
     the first two paragraphs read perfectly. Only applied to answers long
     enough to have structure: "Yes" ends without punctuation and is fine. */
  if (answer.length > 80 && !ENDS_CLEANLY.test(answer)) flags.push("truncated");

  if (typeof input.minLength === "number" && answer.length < input.minLength) {
    flags.push("truncated");
  }

  /* RELEVANCE IS NOT DECIDED HERE, AND THAT IS THE POINT.
   *
   * This module first judged "did it answer the question" by overlap of
   * content words, catching only the case where an answer shared NOTHING with
   * what was asked. Its own test killed it on the first run: "how did the
   * business perform financially in Q3" against "Revenue for the quarter came
   * to 1.2 million, up 8 percent" shares no word at all and is a perfect
   * answer. Loosening the threshold would not have fixed it, because the
   * signal itself is wrong: a good answer routinely uses different vocabulary
   * from its question, and a false flag here pays a larger model to improve
   * something that was already right, on every request that trips it, forever.
   *
   * So relevance is exactly the judgement a rule cannot make, and therefore the
   * one place a second model earns its cost. The flag stays in the union as the
   * contract that stage will emit; nothing computes it from text. Deterministic
   * where possible, model only where necessary, and being honest about which
   * side of that line a check falls on is the whole discipline. */

  const unique = [...new Set(flags)].sort();
  return {
    sufficient: unique.length === 0,
    flags: unique,
    reason: unique.length === 0 ? "No rule flagged this answer." : REASONS[unique[0]],
  };
}

const REASONS: Record<VerificationFlag, string> = {
  empty: "The model returned nothing.",
  truncated: "The answer stops mid-sentence or is shorter than the caller required.",
  refused: "The model declined to answer.",
  deferred: "The model promised to do the work later instead of doing it.",
  ignored_question: "The answer has nothing in common with what was asked.",
  placeholder: "The answer contains placeholder text the model did not fill in.",
};

/**
 * Should a flagged answer be retried on a better model?
 *
 * Not every flag is worth paying to fix, and this is where a cascade stops
 * being expensive theatre.
 *
 * A REFUSAL IS USUALLY CORRECT. A model declining to produce something is very
 * often the system working, and escalating a refusal to a larger model is
 * paying to have a policy overruled. So refusal alone does not escalate: it is
 * reported to the caller, which is the honest outcome.
 *
 * The flags that DO escalate are the ones where the model tried and fell short,
 * which is exactly the failure mode a cheaper model has and a better one does
 * not.
 */
const ESCALATABLE: ReadonlySet<VerificationFlag> = new Set<VerificationFlag>([
  "empty",
  "truncated",
  "deferred",
  "ignored_question",
  "placeholder",
]);

export function shouldEscalate(verdict: VerificationVerdict): boolean {
  return verdict.flags.some((f) => ESCALATABLE.has(f));
}
