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
const BODY_LIKE = new Set(["body", "description", "notes", "details"]);

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
): Autofilled {
  const values: Record<string, unknown> = {};
  const missingRequired: string[] = [];
  const fields = form?.fields ?? [];

  // Extracted once, reused across fields. Cheap + deterministic.
  let titleExtraction: string | undefined;
  let titleExtracted = false;
  let bodyExtraction: string | undefined;
  let bodyExtracted = false;

  for (const field of fields) {
    let value: unknown;

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
        if (!isEmpty(bodyExtraction)) value = bodyExtraction;
      }
    }

    // (c) the FormSpec's own default.
    if (isEmpty(value) && !isEmpty(field.defaultValue)) {
      value = field.defaultValue;
    }

    if (!isEmpty(value)) {
      values[field.name] = value;
    } else if (field.required) {
      missingRequired.push(field.name);
    }
  }

  return { values, missingRequired };
}
