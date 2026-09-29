/**
 * Deterministic intake for a code task: turn an ambiguous prompt into a FROZEN
 * spec through fixed multiple-choice questions.
 *
 * TWO PROPERTIES THE OPERATOR ASKED FOR
 *
 * 1. DETERMINISTIC multiple-choice only. A question's answer space is a fixed,
 *    enumerated option set, never free text a model has to interpret. The
 *    engine here is generic - the questions are DATA supplied by config - so it
 *    invents no product structure; the small default set below is grounded in
 *    the team engineering directive (tests, data/learning, reversibility) and is
 *    meant to be extended, not treated as a fixed claim.
 * 2. DEFERRED, BATCHED clarification. Nothing blocks up front: every unanswered
 *    question resolves to its default and is returned in `open` so the whole set
 *    can be confirmed in ONE batch at the end. Each open item carries the
 *    assumption taken, so the batch reads "I assumed X - confirm or change".
 *
 * A frozen spec is content-hashed, so a later stage (a review, a conformance
 * check) can reference the exact spec a change was built under.
 *
 * Pure: no model call, no network, no clock (the caller supplies the timestamp).
 */
import { createHash } from "node:crypto";

export interface SpecOption {
  id: string;
  label: string;
  /** Imperative guidance the AUTHOR must follow when this option is the resolved
   *  answer. Optional: a spec-record-only question (no authoring impact) omits it.
   *  Present on the ambiguity-resolving questions so the frozen spec actually
   *  GOVERNS what is authored, instead of being recorded and ignored. */
  directive?: string;
}
export interface SpecQuestion {
  id: string;
  prompt: string;
  /** Enumerated, deterministic. Never free text. */
  options: SpecOption[];
  /** Option id used when the question is left unanswered. */
  default: string;
}
export interface FrozenSpec {
  prompt: string;
  /** questionId -> optionId, fully resolved. */
  answers: Record<string, string>;
  createdAtIso: string;
  /** Content hash over (prompt, answers); stable and order-independent. */
  hash: string;
}

/**
 * A starting catalog grounded in the engineering directive - what any code task
 * here must specify. Extend via config; do not treat as exhaustive.
 */
export const DEFAULT_SPEC_QUESTIONS: readonly SpecQuestion[] = [
  {
    id: "tests",
    prompt: "What test coverage must this change ship with?",
    options: [
      { id: "unit", label: "Unit only" },
      { id: "contract", label: "Unit and contract" },
      { id: "all", label: "Unit, contract and end to end" },
    ],
    default: "all",
  },
  {
    id: "data",
    prompt: "Does this change persist or learn from data?",
    options: [
      { id: "none", label: "No new data" },
      { id: "analytics", label: "Analytics and audit only" },
      { id: "durable", label: "A durable entity (triple-write)" },
    ],
    default: "analytics",
  },
  {
    id: "reversibility",
    prompt: "How reversible is this change?",
    options: [
      { id: "reversible", label: "Fully reversible" },
      { id: "guarded", label: "Migration-guarded" },
      { id: "irreversible", label: "Irreversible, needs sign-off" },
    ],
    default: "reversible",
  },
  // Ambiguity-resolving questions (these carry AUTHOR directives). The scored
  // dogfood matrix found the factory author a source and a test from two different
  // readings of an ambiguous prompt (parseRange: is '1 - 3' valid? is '1,,2'
  // malformed?), so they could never both pass. Pinning ONE reading up front and
  // feeding it to the author is the root-cause fix.
  {
    id: "error_handling",
    prompt: "How should invalid or malformed input be handled?",
    options: [
      { id: "throw", label: "Throw an error", directive: "On invalid or malformed input, THROW an error - do not silently return a default, null, or a partial result. The tests must assert the throw." },
      { id: "empty", label: "Return an empty/neutral value", directive: "On invalid or malformed input, return an empty or neutral value (e.g. [] or null); do NOT throw. The tests must assert that returned value, not a throw." },
      { id: "best_effort", label: "Best-effort (skip bad parts)", directive: "On invalid or malformed input, be best-effort: skip the bad portion and continue; do NOT throw. The tests must assert the skipping behavior." },
    ],
    default: "throw",
  },
  {
    id: "input_strictness",
    prompt: "How strictly is input format parsed?",
    options: [
      { id: "strict", label: "Strict (reject unexpected formatting)", directive: "Parse input STRICTLY: reject unexpected formatting (e.g. stray whitespace inside a token) as invalid. Source and tests must follow this same strict reading." },
      { id: "lenient", label: "Lenient (tolerate incidental whitespace)", directive: "Parse input LENIENTLY: tolerate incidental whitespace/formatting. Source and tests must follow this same lenient reading." },
    ],
    default: "strict",
  },
];

/**
 * Resolve answers against a question set. A missing answer falls back to the
 * question's default and the question is returned in `open`, so the defaulted
 * ones can be confirmed in one batch at the end rather than blocking up front.
 * An answer that names an unknown question or option throws - the answer space
 * is fixed, so an off-menu value is a bug, not a choice.
 */
export function resolveIntake(
  questions: readonly SpecQuestion[],
  answers: Record<string, string> = {},
): { answers: Record<string, string>; open: SpecQuestion[] } {
  const byId = new Map(questions.map((q) => [q.id, q]));
  for (const [qid, oid] of Object.entries(answers)) {
    const q = byId.get(qid);
    if (!q) throw new Error(`unknown spec question: ${qid}`);
    if (!q.options.some((o) => o.id === oid)) throw new Error(`unknown option "${oid}" for question "${qid}"`);
  }
  const resolved: Record<string, string> = {};
  const open: SpecQuestion[] = [];
  for (const q of questions) {
    if (q.id in answers) {
      resolved[q.id] = answers[q.id];
    } else {
      resolved[q.id] = q.default;
      open.push(q);
    }
  }
  return { answers: resolved, open };
}

/** A general anti-contradiction directive prepended to EVERY author prompt. The
 *  scored dogfood matrix found the #1 non-convergence cause is a source and a test
 *  authored from two different readings of an ambiguous point; this instructs the
 *  author to pick ONE reading and apply it to both. Task-agnostic, so it never
 *  over-engineers a simple task. */
export const AUTHOR_CONSISTENCY_DIRECTIVE =
  "Author the implementation and its tests from ONE consistent interpretation of the spec. For any input whose validity or behavior is ambiguous, pick a single reading and make BOTH the source and the tests follow it - never let a test assert behavior the source does not implement.";

/** The AUTHOR directives implied by the resolved answers: for each answer whose
 *  chosen option carries a `directive`, that directive. This is what makes the
 *  frozen spec GOVERN authoring (not just get recorded). Pure; order follows the
 *  question list. */
export function specDirectives(
  questions: readonly SpecQuestion[],
  answers: Record<string, string>,
): string[] {
  const out: string[] = [];
  for (const q of questions) {
    const oid = answers[q.id];
    if (!oid) continue;
    const opt = q.options.find((o) => o.id === oid);
    if (opt?.directive) out.push(opt.directive);
  }
  return out;
}

/** Prepend the consistency directive + the resolved spec directives to an author
 *  prompt, so the model authors UNDER the governed spec. Returns the prompt
 *  unchanged shape (just enriched). Pure. */
export function withSpecDirectives(prompt: string, directives: readonly string[]): string {
  const block = ["Spec directives (follow exactly):", `- ${AUTHOR_CONSISTENCY_DIRECTIVE}`, ...directives.map((d) => `- ${d}`)].join("\n");
  return `${block}\n\n${prompt}`;
}

/** Canonical, order-independent serialization for hashing. */
export function canonicalSpec(prompt: string, answers: Record<string, string>): string {
  const keys = Object.keys(answers).sort();
  return JSON.stringify({ prompt: prompt.trim(), answers: keys.map((k) => [k, answers[k]]) });
}

/** Freeze a spec: the prompt, the fully-resolved answers, and a content hash. */
export function freezeSpec(prompt: string, answers: Record<string, string>, nowIso: string): FrozenSpec {
  const hash = "spec_" + createHash("sha256").update(canonicalSpec(prompt, answers)).digest("hex").slice(0, 24);
  return { prompt: prompt.trim(), answers, createdAtIso: nowIso, hash };
}
