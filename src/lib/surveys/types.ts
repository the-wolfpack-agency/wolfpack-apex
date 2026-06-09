/**
 * Survey builder — shared types.
 *
 * Surveys are owned in-house (no third-party SaaS): a survey is a JSON
 * schema of questions rendered at the public responder /s/<slug>. The
 * schema is intentionally small — the five question types below cover
 * the ~80% the agency actually runs — and versionable: new types append
 * to QUESTION_TYPES without breaking stored schemas.
 */

export const QUESTION_TYPES = [
  "short_text",
  "long_text",
  "single_choice",
  "multiple_choice",
  "rating",
  /** Validated email field (e.g. the contact-capture block). */
  "email",
  /** Non-input content block: a heading + optional body paragraph. */
  "section",
] as const;

export type QuestionType = (typeof QUESTION_TYPES)[number];

/** Question types that don't collect an answer. */
export const CONTENT_QUESTION_TYPES: readonly QuestionType[] = ["section"];

export const SURVEY_STATUSES = ["draft", "published", "closed"] as const;
export type SurveyStatus = (typeof SURVEY_STATUSES)[number];

/**
 * Conditional visibility. A question with `visibleIf` is only shown (and
 * only required) when the referenced question's answer satisfies the
 * condition — `equals` for single-value answers, `includes` for a
 * multiple_choice selection. Powers blocks like "If Yes, collect contact
 * details".
 */
export interface VisibleIf {
  questionId: string;
  equals?: string | number;
  includes?: string;
}

export interface SurveyQuestion {
  /** Stable id used as the key in a response's `answers` map. */
  id: string;
  type: QuestionType;
  label: string;
  required: boolean;
  /** Required for single_choice / multiple_choice. */
  options?: string[];
  /** Top of the scale for `rating` (default 5). */
  max?: number;
  /** Sub-prompt / instructions shown under the label (e.g. "Select one"). */
  helpText?: string;
  /** Choice questions: offer an "Other ___" with a free-text capture. */
  allowOther?: boolean;
  /** multiple_choice: cap how many options may be selected (e.g. "up to three"). */
  maxSelections?: number;
  /** `section` body paragraph (intro copy under the heading). */
  body?: string;
  /** Show + require this question only when the condition is met. */
  visibleIf?: VisibleIf;
}

/** Free-text sentinel an "Other" choice submits when no option matches. */
export const OTHER_VALUE_PREFIX = "other:";

export interface SurveySchema {
  questions: SurveyQuestion[];
}

export interface Survey {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  schema: SurveySchema;
  status: SurveyStatus;
  qrCodeId: string | null;
  clientId: string | null;
  createdByUserId: string | null;
  createdByUserRole: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Whether the linked QR code is still live (not archived). Only set on
   * list reads; undefined when unknown. A survey can keep a `qrCodeId`
   * whose code was later archived — the builder uses this to offer
   * "Generate QR" (re-link) instead of showing a dead code.
   */
  qrActive?: boolean;
  /**
   * Visual theme for the public responder (client branding). null/"default"
   * = Instinct dark/gold; "porsche" = white canvas + Guards Red + Porsche
   * Next (matches the Porsche site). Drives a palette in ResponderForm.
   */
  theme?: string | null;
}

/** Supported responder themes (client brand skins). */
export const SURVEY_THEMES = ["default", "porsche", "porsche-sage"] as const;
export type SurveyTheme = (typeof SURVEY_THEMES)[number];

/** A single answer value, keyed by question id. */
export type AnswerValue = string | string[] | number;
export type AnswerMap = Record<string, AnswerValue>;

export interface SurveyResponse {
  id: string;
  surveyId: string;
  answers: AnswerMap;
  respondentFingerprint: string | null;
  qrScanId: string | null;
  /** Time-on-form in ms (migration 162) — powers avg time-to-complete. */
  durationMs: number | null;
  device: string | null;
  country: string | null;
  referrer: string | null;
  submittedAt: string;
}

/** A public responder load — the top of the completion funnel (migration 162). */
export interface SurveyView {
  surveyId: string;
  device: string | null;
  country: string | null;
  referrer: string | null;
  qrScanId: string | null;
  viewedAt: string;
}
