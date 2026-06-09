/**
 * Survey validation — pure, no I/O. Shared verbatim by the builder API
 * (schema validation on save) and the public responder API (answer
 * validation on submit) so the rule can't drift between what the UI
 * believes and what the server enforces.
 *
 * SECURITY: the public submit path is unauthenticated, so answers are
 * fully untrusted. `validateAnswers` is the gate — it rejects unknown
 * questions, wrong types, out-of-range ratings, and choices that aren't
 * in the offered options. Never persist a response that fails it.
 */

import {
  QUESTION_TYPES,
  type AnswerMap,
  type SurveyQuestion,
  type SurveySchema,
} from "./types";

export type ValidationResult = { ok: true } | { ok: false; error: string };

const SLUG_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const SLUG_LENGTH = 7;

/** Crockford-style base32 (ambiguous glyphs removed), matching the QR slugs. */
export function generateSurveySlug(): string {
  let out = "";
  for (let i = 0; i < SLUG_LENGTH; i += 1) {
    out += SLUG_ALPHABET[Math.floor(Math.random() * SLUG_ALPHABET.length)];
  }
  return out;
}

const CHOICE_TYPES = new Set(["single_choice", "multiple_choice"]);

/** Validate a survey definition before it is saved/published. */
export function validateSchema(schema: unknown): ValidationResult {
  if (!schema || typeof schema !== "object") {
    return { ok: false, error: "schema must be an object" };
  }
  const questions = (schema as SurveySchema).questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    return { ok: false, error: "a survey needs at least one question" };
  }
  const seen = new Set<string>();
  for (const q of questions) {
    if (!q || typeof q !== "object") {
      return { ok: false, error: "each question must be an object" };
    }
    if (typeof q.id !== "string" || q.id.length === 0) {
      return { ok: false, error: "each question needs a non-empty id" };
    }
    if (seen.has(q.id)) {
      return { ok: false, error: `duplicate question id: ${q.id}` };
    }
    seen.add(q.id);
    if (!(QUESTION_TYPES as readonly string[]).includes(q.type)) {
      return { ok: false, error: `unknown question type: ${String(q.type)}` };
    }
    if (typeof q.label !== "string" || q.label.trim().length === 0) {
      return { ok: false, error: `question "${q.id}" needs a label` };
    }
    if (typeof q.required !== "boolean") {
      return { ok: false, error: `question "${q.id}" needs a boolean "required"` };
    }
    if (CHOICE_TYPES.has(q.type)) {
      if (!Array.isArray(q.options) || q.options.length < 1) {
        return { ok: false, error: `choice question "${q.id}" needs options` };
      }
      if (q.options.some((o) => typeof o !== "string" || o.length === 0)) {
        return { ok: false, error: `question "${q.id}" has an empty option` };
      }
    }
    if (q.type === "rating" && q.max !== undefined) {
      if (typeof q.max !== "number" || q.max < 2 || q.max > 10) {
        return { ok: false, error: `rating "${q.id}" max must be 2–10` };
      }
    }
  }
  return { ok: true };
}

function answerError(q: SurveyQuestion, msg: string): ValidationResult {
  return { ok: false, error: `"${q.label}": ${msg}` };
}

/**
 * Validate untrusted submitted answers against a survey's schema.
 * Enforces required-ness, type correctness, choice membership, and
 * rating range. Returns ok:false on the first problem.
 */
export function validateAnswers(
  schema: SurveySchema,
  answers: unknown,
): ValidationResult {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    return { ok: false, error: "answers must be an object" };
  }
  const map = answers as AnswerMap;
  const known = new Set(schema.questions.map((q) => q.id));
  for (const key of Object.keys(map)) {
    if (!known.has(key)) {
      return { ok: false, error: `unknown question: ${key}` };
    }
  }
  for (const q of schema.questions) {
    const val = map[q.id];
    const missing =
      val === undefined ||
      val === null ||
      (typeof val === "string" && val.trim() === "") ||
      (Array.isArray(val) && val.length === 0);
    if (missing) {
      if (q.required) return answerError(q, "this question is required");
      continue;
    }
    switch (q.type) {
      case "short_text":
      case "long_text":
        if (typeof val !== "string") return answerError(q, "expected text");
        if (val.length > 5000) return answerError(q, "answer is too long");
        break;
      case "single_choice":
        if (typeof val !== "string" || !(q.options ?? []).includes(val)) {
          return answerError(q, "not one of the offered options");
        }
        break;
      case "multiple_choice": {
        if (!Array.isArray(val)) return answerError(q, "expected a list");
        const opts = new Set(q.options ?? []);
        if (val.some((v) => typeof v !== "string" || !opts.has(v))) {
          return answerError(q, "contains an option that wasn't offered");
        }
        if (new Set(val).size !== val.length) {
          return answerError(q, "contains duplicate selections");
        }
        break;
      }
      case "rating": {
        const max = q.max ?? 5;
        if (typeof val !== "number" || !Number.isInteger(val) || val < 1 || val > max) {
          return answerError(q, `must be a whole number from 1 to ${max}`);
        }
        break;
      }
      default:
        return answerError(q, "unsupported question type");
    }
  }
  return { ok: true };
}

/**
 * Aggregate a set of responses into per-question summaries for the
 * results view. Pure so it can be unit-tested without a DB. Choice
 * questions get option counts; ratings get an average + count; text
 * questions get a sample of recent answers.
 */
export function aggregateResponses(
  schema: SurveySchema,
  answerMaps: AnswerMap[],
): Array<{
  questionId: string;
  label: string;
  type: SurveyQuestion["type"];
  answered: number;
  optionCounts?: Record<string, number>;
  average?: number;
  textSamples?: string[];
}> {
  return schema.questions.map((q) => {
    const values = answerMaps
      .map((a) => a[q.id])
      .filter((v) => v !== undefined && v !== null && v !== "");
    const base = { questionId: q.id, label: q.label, type: q.type, answered: values.length };
    if (q.type === "single_choice" || q.type === "multiple_choice") {
      const counts: Record<string, number> = {};
      for (const o of q.options ?? []) counts[o] = 0;
      for (const v of values) {
        const picks = Array.isArray(v) ? v : [v];
        for (const p of picks) if (typeof p === "string" && p in counts) counts[p] += 1;
      }
      return { ...base, optionCounts: counts };
    }
    if (q.type === "rating") {
      const nums = values.filter((v): v is number => typeof v === "number");
      const average = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
      return { ...base, average: Math.round(average * 100) / 100 };
    }
    return {
      ...base,
      textSamples: values.filter((v): v is string => typeof v === "string").slice(0, 10),
    };
  });
}
