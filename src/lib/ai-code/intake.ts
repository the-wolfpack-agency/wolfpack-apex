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
