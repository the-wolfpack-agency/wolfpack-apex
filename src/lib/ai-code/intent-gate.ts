/**
 * Intent gate: the floor that stops a NON-request from entering the factory.
 *
 * Found by dogfooding: typing "hello" authored a change, cleared every gate, and
 * offered a mergeable PR. The code gate validates SAFETY and QUALITY of a change;
 * it never asked whether the prompt was a change request at all. This is that
 * missing check - deterministic, server-side (so no UI can bypass it), and it runs
 * BEFORE any authoring, so a greeting costs zero model tokens and produces nothing.
 *
 * Precision-first: the criterion is ACTIONABLE INTENT, not length. A terse but real
 * request ("add k", "edit src/x.ts", "tweak policy") passes; a greeting / empty /
 * no-signal fragment is rejected. We would rather let a borderline request through
 * (the code gate still governs it) than block a genuine one - so the only hard
 * rejects are: empty, a bare greeting, or no actionable signal in a short fragment.
 */

/** Verbs that signal an actual change request (dev-flavored, generous on purpose). */
const ACTION_VERBS = /\b(add|create|build|make|implement|write|fix|change|update|modify|edit|remove|delete|drop|refactor|dedupe|rename|move|replace|wire|hook|migrate|optimi[sz]e|improve|extend|support|handle|render|display|show|validate|enforce|gate|guard|test|document|generate|convert|upgrade|bump|patch|revert|restore|configure|set\s+up|integrate|tweak|tidy|adjust|clean|cleanup|simplify|tune|polish|rework|revamp|restyle|reskin|style|colou?r|format|lint|align|standardi[sz]e|normali[sz]e|cache|sort|filter|group|split|extract|inline|log|instrument|track|audit|secure|sanitize|parse|serialize|stream|enable|disable|swap|rename)\b/i;
/** A named file: a filename segment ending in a code extension. Linear (the body
 *  class excludes `.` so there is no backtracking ambiguity) - ReDoS-safe on the
 *  uncontrolled prompt. Matches the last segment, e.g. `page.tsx` in any dir path. */
const FILE_HINT = /\b[\w-]+\.(tsx?|jsx?|mjs|cjs|json|css|scss|sql|md|ya?ml|py|rb|go|rs|java|php|sh)\b/i;
/** Symptom / problem words - a bug report is a valid request even with no verb. */
const PROBLEM_SIGNAL = /\b(broken?|broke|crash(?:es|ing|ed)?|error|fails?|failing|failed|bug|issue|slow|laggy|wrong|incorrect|doesn'?t|does\s+not|isn'?t|is\s+not|not\s+working|hang(?:s|ing)?|freez(?:e|es|ing)|leak(?:s|ing)?|regression|500|404|403|undefined|null|nan|flaky|stuck)\b/i;
/** Bare greetings / filler that are never a request, even if repeated. */
const GREETING_ONLY = /^(?:hi|hey+|hello|yo|sup|howdy|greetings|thanks?|thank\s*you|ty|ok(?:ay)?|cool|nice|great|awesome|test(?:ing)?|ping|hola|gm|gn|good\s*(?:morning|afternoon|evening|night)|how\s+are\s+you\??|what'?s\s+up\??)[\s!.?]*$/i;

export interface IntentVerdict {
  ok: boolean;
  /** When ok=false, a short client-facing reason (never leaks internals). */
  reason?: string;
}

/** The friendly message shown when a prompt is not a change request. */
export const NOT_A_REQUEST_MESSAGE =
  "That doesn't look like a change request yet. Describe the change you want - e.g. \"add a rate limit to the login route\" or name a file to edit. Pick a chip to start from a template.";

/**
 * Is this prompt a plausible change request? Pure + deterministic. A diff-supplied
 * run (the caller passes code directly) is governed as-is and skips this gate.
 *
 * Accepts when there is an actionable signal - an action verb, a named file, or a
 * problem/symptom (a bug report). Rejects empty, bare greetings, and fragments with
 * none of those. Precision-first: a real request is never blocked; the code gate
 * still governs anything that passes.
 */
export function looksLikeChangeRequest(prompt: string): IntentVerdict {
  const p = (prompt ?? "").trim();
  if (p.length === 0) return { ok: false, reason: NOT_A_REQUEST_MESSAGE };
  if (GREETING_ONLY.test(p)) return { ok: false, reason: NOT_A_REQUEST_MESSAGE };
  if (ACTION_VERBS.test(p) || FILE_HINT.test(p) || PROBLEM_SIGNAL.test(p)) return { ok: true };
  return { ok: false, reason: NOT_A_REQUEST_MESSAGE };
}
