/**
 * Generic, deterministic form auto-fill for agent execution.
 *
 * When an agent's dispatched tool returns a FormSpec (a structure built to
 * collect human input), an autonomous agent cannot render or click that form.
 * This module fills the form's fields deterministically from the instruction
 * that triggered the step plus any params the tool already parsed, so the agent
 * can drive the SHARED form executor on behalf of its owner with no per-workflow
 * code and no bespoke per-form-kind branch.
 *
 * Priority, per field (first hit wins):
 *   (a) parsedParams[field.name]: the tool's own structured extraction, the
 *       most trustworthy source (it already validated the user's phrasing).
 *   (b) A deterministic extraction from the instruction for common field names:
 *         title / subject / name  <- a "titled/called/named/about X" clause, or
 *                                     the trailing clause of the instruction.
 *         body / description / notes / details <- the instruction remainder.
 *   (c) field.defaultValue: the FormSpec's own safe default (e.g. a default
 *       list id, a default stage, today's date).
 * A required field that none of (a)-(c) can fill lands in `missingRequired`, so
 * the executor can stop and escalate to the owner for the missing input rather
 * than submit an invalid action.
 *
 * RESULT CHAINING. A multi-step agent task can carry the outputs of earlier
 * steps forward (`priorResults`). When a BODY_LIKE field is otherwise only
 * fillable from the raw instruction text AND that instruction REFERENCES prior
 * output (e.g. "summarize the results", "write up the above"), the raw
 * instruction remainder ("summarizing the results") is useless content, so we
 * fill the field from a concise, hard-truncated join of the prior results
 * instead. This is what makes "search for X; create a feature summarizing the
 * results" land a real description. parsedParams and the FormSpec default still
 * win (they are explicit / trustworthy); only the weak instruction-remainder
 * fill is overridden, and only for body-like fields (never title-like).
 *
 * Pure + deterministic + zero-token by design. NOTE: a future enhancement is to
 * fall back to an LLM fill (via the model router in src/lib/ai/models) for hard
 * free-text fields the deterministic rules cannot infer; this pass deliberately
 * keeps no LLM in the loop so it is fully testable and free.
 */

import type { FormField } from "@/lib/assistant/forms/types";

export interface Autofilled {
  /** name -> chosen value, for every field we could fill. */
  values: Record<string, unknown>;
  /** required field names we could NOT fill from any source. */
  missingRequired: string[];
}

/** Field names that take a short "what is this called" value. */
const TITLE_LIKE = new Set(["title", "subject", "name"]);
/** Field names that take the free-text remainder of the instruction. */
const BODY_LIKE = new Set(["body", "description", "content", "notes", "details", "summary"]);

/**
 * Hard cap on the total characters of joined prior-result content folded into a
 * body field. Keeps the carried context bounded so a chained step never balloons
 * the form payload, deterministic regardless of how much earlier steps emitted.
 */
const PRIOR_RESULTS_BODY_CAP = 1000;

/**
 * Tokens that signal the instruction is referring back to an EARLIER step's
 * output ("summarize the results", "write up the above", "use those", ...). A
 * deterministic word-boundary match drives the result-chaining body fill. Kept
 * conservative on purpose: a false positive only happens when the instruction
 * literally names prior output, and the rule is gated on priorResults being
 * non-empty anyway.
 */
const PRIOR_REFERENCE_TOKENS = [
  "the results",
  "the above",
  "previous",
  "them",
  "those",
  "that",
  "the findings",
  "the output",
];

/** True when the instruction references the output of a prior step. */
function referencesPriorOutput(instruction: string): boolean {
  const lower = (instruction ?? "").toLowerCase();
  return PRIOR_REFERENCE_TOKENS.some((tok) =>
    new RegExp(`\\b${tok.replace(/\s+/g, "\\s+")}\\b`).test(lower),
  );
}

/**
 * Build a concise, hard-truncated body from the carried prior results. Joins the
 * already-truncated step answers in order and clamps the total to
 * PRIOR_RESULTS_BODY_CAP characters so the payload stays bounded. Returns
 * undefined when there is nothing usable to carry forward. Pure.
 */
function summarizePriorResults(
  priorResults: { instruction: string; result: string }[] | undefined,
): string | undefined {
  if (!priorResults || priorResults.length === 0) return undefined;
  const joined = priorResults
    .map((p) => (p?.result ?? "").replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0)
    .join("\n\n");
  if (joined.length === 0) return undefined;
  return joined.length > PRIOR_RESULTS_BODY_CAP
    ? `${joined.slice(0, PRIOR_RESULTS_BODY_CAP - 1)}…`
    : joined;
}

/**
 * Extract a title-like value from the instruction.
 *
 * Prefers an explicit "titled/called/named/about X" clause (matching the same
 * phrasing the create-task tool's intent matcher recognizes), and otherwise
 * falls back to the trailing clause of the instruction after a leading
 * imperative verb ("add a task <X>", "create an event <X>"). Returns undefined
 * when nothing sensible can be extracted.
 */
function extractTitle(instruction: string): string | undefined {
  const explicit =
    /\b(?:titled|called|named|about|for)\s+["']?([^"'\n]{2,120}?)["']?\s*$/i.exec(
      instruction,
    );
  if (explicit) return explicit[1].trim();

  // Trailing clause after a leading imperative + optional article + a noun like
  // "task"/"event"/"email"/"message"/"todo". "add a task Buy milk" -> "Buy milk".
  const trailing =
    /^\s*(?:please\s+)?(?:create|add|make|new|schedule|send|draft|log)\s+(?:an?\s+)?(?:new\s+)?(?:to[\s-]?do|task|event|meeting|email|message|reminder|note)?\s*[:,-]?\s*(.+?)\s*$/i.exec(
      instruction,
    );
  if (trailing && trailing[1].trim().length >= 2) {
    const candidate = trailing[1].trim();
    // Avoid echoing a bare connective ("to", "for") as a title.
    if (!/^(?:to|for|about|that|which|the)\b/i.test(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Extract a body-like value: the instruction remainder. We use the whole
 * instruction (trimmed) as the notes/description, since the title extraction
 * already isolates the short label and a body is best served by the full
 * context. Returns undefined for an empty instruction.
 */
function extractBody(instruction: string): string | undefined {
  const t = instruction.trim();
  return t.length > 0 ? t : undefined;
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

/**
 * Auto-fill a form deterministically. Never throws; always returns a result.
 */
export function autofillForm(
  form: { fields: FormField[] },
  instruction: string,
  parsedParams?: Record<string, unknown>,
  priorResults?: { instruction: string; result: string }[],
): Autofilled {
  const values: Record<string, unknown> = {};
  const missingRequired: string[] = [];
  const fields = form?.fields ?? [];

  // Result-chaining inputs, resolved once. The prior-results body is only built
  // when the instruction actually refers back to an earlier step's output AND we
  // have something to carry forward; otherwise it stays undefined and the body
  // falls back to the normal instruction-remainder extraction (existing behavior
  // is unchanged for every non-chained call).
  const chainBody =
    referencesPriorOutput(instruction) && priorResults && priorResults.length > 0
      ? summarizePriorResults(priorResults)
      : undefined;

  // Extracted once, reused across fields. Cheap + deterministic.
  let titleExtraction: string | undefined;
  let titleExtracted = false;
  let bodyExtraction: string | undefined;
  let bodyExtracted = false;

  for (const field of fields) {
    let value: unknown;
    // Track whether the only thing filling a body-like field was the weak
    // instruction-remainder extraction. If so, a prior-results reference may
    // override it (the remainder, e.g. "summarizing the results", is not real
    // content). parsedParams and the FormSpec default are stronger and stand.
    let bodyFromInstructionRemainder = false;

    // (a) the tool's own parsed param for this field name.
    if (parsedParams && !isEmpty(parsedParams[field.name])) {
      value = parsedParams[field.name];
    }

    // (b) deterministic extraction from the instruction for common names.
    if (isEmpty(value)) {
      if (TITLE_LIKE.has(field.name)) {
        if (!titleExtracted) {
          titleExtraction = extractTitle(instruction);
          titleExtracted = true;
        }
        if (!isEmpty(titleExtraction)) value = titleExtraction;
      } else if (BODY_LIKE.has(field.name)) {
        if (!bodyExtracted) {
          bodyExtraction = extractBody(instruction);
          bodyExtracted = true;
        }
        if (!isEmpty(bodyExtraction)) {
          value = bodyExtraction;
          bodyFromInstructionRemainder = true;
        }
      }
    }

    // (c) the FormSpec's own default.
    if (isEmpty(value) && !isEmpty(field.defaultValue)) {
      value = field.defaultValue;
    }

    // (d) RESULT CHAINING. For a body-like field that is either still empty OR
    // was only filled by the weak instruction-remainder, fold in the carried
    // prior-step output when the instruction references it. Title-like fields
    // are NEVER filled from prior results (a title is a short label, not a body
    // of carried text). Applied before the missingRequired decision so a chained
    // body counts as filled.
    if (
      BODY_LIKE.has(field.name) &&
      !isEmpty(chainBody) &&
      (isEmpty(value) || bodyFromInstructionRemainder)
    ) {
      value = chainBody;
    }

    if (!isEmpty(value)) {
      values[field.name] = value;
    } else if (field.required) {
      missingRequired.push(field.name);
    }
  }

  return { values, missingRequired };
}
