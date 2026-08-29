/**
 * Whole jobs, not single questions.
 *
 * WHY SINGLE PROMPTS WERE NOT ENOUGH
 *
 * The first-day journey asks one question at a time and every step passed
 * while the product was unusable for a real task. Walking one continuous
 * conversation on 2026-08-29 — find out when an invoice is due — failed at
 * all three turns, each for a different reason:
 *
 *   "what are the payment terms in the viaPeople work order?"
 *     -> "connect your DMS" (an ambiguous noun claimed before retrieval ran)
 *   "the viaPeople work order"
 *     -> three unrelated files (filenames were never searchable)
 *   "when do we have to pay?"
 *     -> four wrong documents offered as "related"
 *
 * None of those is visible one question at a time. The second turn only fails
 * because of what the first turn asked, and the whole point of an assistant is
 * that turn two knows about turn one.
 *
 * WHAT A SCENARIO ASSERTS
 *
 * Per turn, the kind of answer expected, and where it matters, a string the
 * answer must contain. `mustContain` is used sparingly and only for facts the
 * deployment's own documents settle: it is the difference between "it said
 * something" and "it said the right thing", and it is also the fastest way to
 * make a journey depend on one corpus, so every use of it lives in the
 * deployment's own config rather than here.
 */
import type { AnswerKind } from "./journey";

export interface ScenarioTurn {
  /** Typed verbatim, in order. */
  say: string;
  /** Kinds of answer that count as working. */
  expect: AnswerKind[];
  /** Optional: a string the answer must contain, case-insensitive. */
  mustContain?: string;
  /** Wall clock ceiling for this turn. */
  budgetMs: number;
  /** What this turn is really checking. Shown when it fails. */
  because: string;
}

export interface Scenario {
  id: string;
  /** The job somebody is trying to finish. */
  goal: string;
  turns: ScenarioTurn[];
}

/**
 * Scenarios that hold on ANY deployment.
 *
 * No filename, no figure, no topic only we hold. Each one tests a BEHAVIOUR
 * that either works or does not regardless of what is in the corpus, which is
 * what makes them portable to a client instance on day one.
 */
export const UNIVERSAL_SCENARIOS: Scenario[] = [
  {
    id: "asks-which-one",
    goal: "Ask something underspecified and be helped rather than refused.",
    turns: [
      {
        say: "when do we have to pay?",
        /* Either it answers, or it names candidates, or it says plainly that
           it holds nothing. All three are honest. What must not happen is a
           refusal telling somebody to open a support ticket over a question a
           colleague would answer with "which contract?". */
        expect: ["substantive", "empty", "needs_setup"],
        budgetMs: 12_000,
        because: "An underspecified question must not be sent to a support queue.",
      },
    ],
  },
  {
    id: "capability-then-use",
    goal: "Find out what it can do, then immediately do one of those things.",
    turns: [
      {
        say: "what can you do?",
        expect: ["substantive", "product_tour"],
        budgetMs: 8_000,
        because: "Everybody asks this first and it must not read as an error.",
      },
      {
        say: "find anything about invoices",
        /* Turn two after turn one: the conversation must survive a topic
           change, which is the commonest thing a person does. */
        expect: ["substantive", "empty", "needs_setup"],
        budgetMs: 10_000,
        because: "Acting on what it just offered must work.",
      },
    ],
  },
  {
    id: "does-not-invent",
    goal: "Ask for something that cannot exist and get an honest answer.",
    turns: [
      {
        say: "what is the quarterly revenue of the moon department",
        expect: ["empty", "needs_setup"],
        budgetMs: 12_000,
        because: "Confabulation destroys trust faster than any missing feature.",
      },
      {
        /* After a miss, the next question must still work. A conversation that
           gives up once it has failed is worse than one that never failed. */
        say: "what can you do?",
        expect: ["substantive", "product_tour"],
        budgetMs: 8_000,
        because: "One miss must not poison the rest of the conversation.",
      },
    ],
  },
  {
    id: "ambiguous-nouns-reach-documents",
    goal: "Use a word that also means something in another system.",
    turns: [
      {
        say: "what does the work order say about payment",
        /* "Work order" was claimed by the DMS before retrieval ran, so this
           answered "connect your DMS" for a document question. */
        expect: ["substantive", "empty"],
        budgetMs: 12_000,
        because: "An ambiguous noun must not be claimed by a system nobody connected.",
      },
    ],
  },
];

/**
 * Corpus scenarios: multi-turn, and they need the deployment's own facts.
 *
 * Supplied as config for the same reason single probes are. A scenario naming
 * our SOW proves nothing on a client instance and fails there on day one.
 */
export interface CorpusScenarioConfig {
  /** A document in this deployment, named as somebody would say it. */
  documentName?: string;
  /** A distinctive string that document's content contains. */
  documentContains?: string;
}

/**
 * The task that failed at every turn, as a portable scenario.
 *
 * Only built when the deployment says which document to use, so it tests the
 * PATTERN — vague question, then name the document, then ask about it — with
 * their material rather than ours.
 */
export function corpusScenario(config: CorpusScenarioConfig): Scenario | null {
  const name = config.documentName?.trim();
  if (!name) return null;
  return {
    id: "name-a-document-then-ask",
    goal: "Narrow a vague question by naming the document, then get the answer.",
    turns: [
      {
        say: name,
        /* Naming a document must find it. This failed because filenames were
           never searchable, which also made the "which one did you mean"
           path a dead end: it asked a question whose answer did not work. */
        expect: ["substantive", "empty"],
        budgetMs: 12_000,
        because: "Naming a document is the first thing anybody does after being asked which one.",
      },
      {
        say: `what does ${name} say about payment?`,
        expect: ["substantive", "empty"],
        ...(config.documentContains ? { mustContain: config.documentContains } : {}),
        budgetMs: 12_000,
        because: "The answer has to come from that document, not from another one.",
      },
    ],
  };
}

export function buildScenarios(config: CorpusScenarioConfig = {}): Scenario[] {
  const corpus = corpusScenario(config);
  return corpus ? [...UNIVERSAL_SCENARIOS, corpus] : UNIVERSAL_SCENARIOS;
}
