/**
 * The gist of a turn: what shape it was, never what it said.
 *
 * THE IDEA BEING TESTED. An agent does not need to hold private data to learn
 * from a decision. What a person asked ABOUT is sensitive; the SHAPE of the
 * exchange is not. "A content question, answered from one document, top score
 * high, judge accepted, no retry" is a complete training example containing
 * nothing that belongs to anybody.
 *
 * WHY IT MATTERS COMMERCIALLY. Instinct is sold one client, one database. So
 * today every deployment starts ignorant and stays ignorant: nothing learned
 * serving one client can help the next, because the data cannot move. A gist
 * is the only artifact that can legitimately cross that boundary, which makes
 * this the difference between selling a tool eighteen times and selling one
 * that is better on the eighteenth than it was on the first.
 *
 * SAFE BY CONSTRUCTION, NOT BY REVIEW. Every field below is drawn from a fixed
 * vocabulary or is a bucketed number. There is no free-text field and no
 * identifier, so there is nothing to redact and nothing to leak. A test walks
 * real production turns and fails if any gist value falls outside its declared
 * vocabulary, which is what makes that claim checkable rather than asserted.
 *
 * THE RE-IDENTIFICATION LINE. A gist specific enough to be useful can be
 * specific enough to identify: "asked about a named incentive tier in a small
 * market" is a shape AND a fingerprint. The defence is that no field here can
 * carry a subject at all. Nothing names a topic, a document, a person or a
 * place. What survives is how the machine behaved, which is the only part
 * worth learning from anyway.
 */

/** How the person framed it. Derived from the sentence, never storing it. */
export type QuestionShape =
  /** Asks what a document CONTAINS. Only reading it answers. */
  | "content"
  /** Asks what the library HOLDS. A list is the right answer. */
  | "existence"
  /** Asks the system to DO something. */
  | "action"
  /** Anything else somebody types. */
  | "other";

/** Where the answer came from. Mirrors the stored source, which is a closed set. */
export type AnswerOrigin =
  | "brain"
  | "tool"
  | "ai"
  | "knowledge_cache"
  | "page_facts"
  | "fallback"
  | "other";

/** Bucketed, because an exact length is a fingerprint and a band is not. */
export type LengthBand = "none" | "short" | "medium" | "long";

/** What happened next, which is the thing being predicted. */
export type TurnOutcome =
  /** The answer admitted having nothing and the person never returned. */
  | "dead_end"
  /** The answer had nothing but the person pushed on. */
  | "pushed_past"
  /** The person asked the same thing again in different words. */
  | "re_asked"
  /** The person continued the conversation. */
  | "continued"
  /** One question, no more. Ambiguous: satisfied or gave up. */
  | "single_turn";

export interface TurnGist {
  shape: QuestionShape;
  origin: AnswerOrigin;
  answerLength: LengthBand;
  questionLength: LengthBand;
  /** Whether the answer carried citations a person could open. */
  hadSources: boolean;
  /** Whether the answer admitted having nothing. */
  admittedMiss: boolean;
  outcome: TurnOutcome;
}

/** The declared vocabularies, exported so a test can hold the gist to them. */
export const VOCABULARY = {
  shape: ["content", "existence", "action", "other"] as QuestionShape[],
  origin: ["brain", "tool", "ai", "knowledge_cache", "page_facts", "fallback", "other"] as AnswerOrigin[],
  band: ["none", "short", "medium", "long"] as LengthBand[],
  outcome: ["dead_end", "pushed_past", "re_asked", "continued", "single_turn"] as TurnOutcome[],
} as const;

export function lengthBand(text: string): LengthBand {
  const n = (text ?? "").trim().length;
  if (n === 0) return "none";
  if (n < 120) return "short";
  if (n < 800) return "medium";
  return "long";
}

const ORIGINS = new Set<string>(VOCABULARY.origin);
export function answerOrigin(source: string | null | undefined): AnswerOrigin {
  const s = String(source ?? "").trim();
  return ORIGINS.has(s) && s !== "other" ? (s as AnswerOrigin) : "other";
}

/* Verbs that ask the system to act rather than to tell. Deliberately small:
   a wrong "other" costs a weaker signal, a wrong "action" would teach the
   model that questions are commands. */
const ACTION_VERB = /^\s*(send|draft|create|book|schedule|add|update|delete|remove|log|file|invite|assign|run|open)\b/i;

/**
 * Reduce a question to its shape.
 *
 * Uses the SAME classifiers the product routes with, rather than a second set
 * of regexes that would drift away from them. If routing changes, the gist
 * changes with it, which is correct: the gist should describe the product that
 * exists, not the one it had when this was written.
 */
export function questionShape(
  question: string,
  deps: {
    isContentQuestion: (q: string) => boolean;
    isExistenceQuestion: (q: string) => boolean;
  },
): QuestionShape {
  const q = (question ?? "").trim();
  if (!q) return "other";
  if (ACTION_VERB.test(q)) return "action";
  if (deps.isContentQuestion(q)) return "content";
  if (deps.isExistenceQuestion(q)) return "existence";
  return "other";
}
