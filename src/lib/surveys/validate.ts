/**
 * Survey validation — pure, no I/O. Shared verbatim by the builder API
 * (schema validation on save) and the public responder API (answer
 * validation on submit) so the rule can't drift between what the UI
 * believes and what the server enforces.
 *
 * SECURITY: the public submit path is unauthenticated, so answers are
 * fully untrusted. `validateAnswers` is the gate — it rejects unknown
 * questions, wrong types, out-of-range ratings, choices that aren't in
 * the offered options, over-limit multi-selects, and required answers
 * that are missing. Conditional (`visibleIf`) questions are only required
 * when their condition is met. Never persist a response that fails it.
 */

import {
  CONTENT_QUESTION_TYPES,
  OTHER_VALUE_PREFIX,
  QUESTION_TYPES,
  type AnswerMap,
  type AnswerValue,
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
// Basic, deliberately-permissive email shape. Real deliverability is
// confirmed downstream; this just blocks obvious garbage at the gate.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Is a value an "Other ___" free-text submission? */
export function isOtherValue(v: unknown): v is string {
  return typeof v === "string" && v.startsWith(OTHER_VALUE_PREFIX);
}
/** The text a respondent typed into an "Other" field (without the prefix). */
export function otherText(v: string): string {
  return v.slice(OTHER_VALUE_PREFIX.length);
}

/** Does a content block (section) carry no answer? */
export function isContentQuestion(q: Pick<SurveyQuestion, "type">): boolean {
  return CONTENT_QUESTION_TYPES.includes(q.type);
}

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
    if (seen.has(q.id)) return { ok: false, error: `duplicate question id: ${q.id}` };
    seen.add(q.id);
    if (!(QUESTION_TYPES as readonly string[]).includes(q.type)) {
      return { ok: false, error: `unknown question type: ${String(q.type)}` };
    }
    if (typeof q.label !== "string" || q.label.trim().length === 0) {
      return { ok: false, error: `question "${q.id}" needs a label` };
    }
    // Content blocks can't be "required" and never collect an answer.
    if (isContentQuestion(q)) {
      if (q.required === true) {
        return { ok: false, error: `section "${q.id}" cannot be required` };
      }
      continue;
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
    if (q.type === "multiple_choice" && q.maxSelections !== undefined) {
      if (
        typeof q.maxSelections !== "number" ||
        !Number.isInteger(q.maxSelections) ||
        q.maxSelections < 1
      ) {
        return { ok: false, error: `"${q.id}" maxSelections must be a positive integer` };
      }
    }
    if (q.type === "rating" && q.max !== undefined) {
      if (typeof q.max !== "number" || q.max < 2 || q.max > 10) {
        return { ok: false, error: `rating "${q.id}" max must be 2–10` };
      }
    }
    if (q.visibleIf !== undefined) {
      const v = q.visibleIf;
      if (!v || typeof v !== "object" || typeof v.questionId !== "string") {
        return { ok: false, error: `"${q.id}" visibleIf needs a questionId` };
      }
      if (v.equals === undefined && v.includes === undefined) {
        return { ok: false, error: `"${q.id}" visibleIf needs equals or includes` };
      }
      if (!seen.has(v.questionId)) {
        // The controlling question must appear earlier in the list.
        return {
          ok: false,
          error: `"${q.id}" visibleIf references "${v.questionId}" which isn't an earlier question`,
        };
      }
    }
  }
  return { ok: true };
}

/** Whether a question's visibleIf condition is satisfied by the answers. */
export function isQuestionActive(q: SurveyQuestion, answers: AnswerMap): boolean {
  if (!q.visibleIf) return true;
  const controlling = answers[q.visibleIf.questionId];
  if (q.visibleIf.equals !== undefined) {
    return controlling === q.visibleIf.equals;
  }
  if (q.visibleIf.includes !== undefined) {
    return Array.isArray(controlling) && controlling.includes(q.visibleIf.includes);
  }
  return true;
}

function answerError(q: SurveyQuestion, msg: string): ValidationResult {
  return { ok: false, error: `"${q.label}": ${msg}` };
}

function isMissing(val: AnswerValue | undefined): boolean {
  return (
    val === undefined ||
    val === null ||
    (typeof val === "string" && val.trim() === "") ||
    (Array.isArray(val) && val.length === 0)
  );
}

/**
 * Validate untrusted submitted answers against a survey's schema.
 * Enforces required-ness (only for active questions), type correctness,
 * choice membership, "Other" free-text, multi-select caps, email shape,
 * and rating range. Returns ok:false on the first problem.
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
    if (!known.has(key)) return { ok: false, error: `unknown question: ${key}` };
  }
  for (const q of schema.questions) {
    if (isContentQuestion(q)) continue; // sections carry no answer
    const val = map[q.id];
    const active = isQuestionActive(q, map);
    if (isMissing(val)) {
      // Required only bites when the question is actually shown.
      if (q.required && active) return answerError(q, "this question is required");
      continue;
    }
    // Even for inactive questions, if an answer is present we still
    // type-check it so nothing malformed gets stored.
    switch (q.type) {
      case "short_text":
      case "long_text":
        if (typeof val !== "string") return answerError(q, "expected text");
        if (val.length > 5000) return answerError(q, "answer is too long");
        break;
      case "email":
        if (typeof val !== "string" || !EMAIL_RE.test(val.trim())) {
          return answerError(q, "enter a valid email address");
        }
        if (val.length > 320) return answerError(q, "email is too long");
        break;
      case "single_choice": {
        if (typeof val !== "string") return answerError(q, "expected a single choice");
        if ((q.options ?? []).includes(val)) break;
        if (q.allowOther && isOtherValue(val)) {
          if (otherText(val).trim() === "") return answerError(q, "describe your “Other” answer");
          if (val.length > 1000) return answerError(q, "“Other” answer is too long");
          break;
        }
        return answerError(q, "not one of the offered options");
      }
      case "multiple_choice": {
        if (!Array.isArray(val)) return answerError(q, "expected a list");
        const opts = new Set(q.options ?? []);
        let others = 0;
        for (const v of val) {
          if (typeof v !== "string") return answerError(q, "invalid selection");
          if (opts.has(v)) continue;
          if (q.allowOther && isOtherValue(v)) {
            others += 1;
            if (otherText(v).trim() === "") return answerError(q, "describe your “Other” answer");
            continue;
          }
          return answerError(q, "contains an option that wasn't offered");
        }
        if (others > 1) return answerError(q, "only one “Other” answer is allowed");
        if (new Set(val).size !== val.length) return answerError(q, "contains duplicate selections");
        if (q.maxSelections && val.length > q.maxSelections) {
          return answerError(q, `select at most ${q.maxSelections}`);
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
 * Aggregate responses into per-question summaries for the results view.
 * Pure. Choice questions get option counts (plus an "Other" bucket +
 * samples when allowOther); ratings get an average; text/email questions
 * get a sample of recent answers. Sections are skipped.
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
  otherCount?: number;
  otherSamples?: string[];
  average?: number;
  textSamples?: string[];
}> {
  return schema.questions
    .filter((q) => !isContentQuestion(q))
    .map((q) => {
      const values = answerMaps
        .map((a) => a[q.id])
        .filter((v) => v !== undefined && v !== null && v !== "");
      const base = { questionId: q.id, label: q.label, type: q.type, answered: values.length };
      if (q.type === "single_choice" || q.type === "multiple_choice") {
        const counts: Record<string, number> = {};
        for (const o of q.options ?? []) counts[o] = 0;
        const otherSamples: string[] = [];
        for (const v of values) {
          const picks = Array.isArray(v) ? v : [v];
          for (const p of picks) {
            if (typeof p !== "string") continue;
            if (p in counts) counts[p] += 1;
            else if (isOtherValue(p)) otherSamples.push(otherText(p));
          }
        }
        return {
          ...base,
          optionCounts: counts,
          otherCount: otherSamples.length,
          otherSamples: otherSamples.slice(0, 10),
        };
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
