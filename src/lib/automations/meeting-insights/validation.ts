/**
 * meeting-insights / validation — hand-rolled input validators.
 *
 * No new runtime deps (per CLAUDE.md "no new runtime dependencies
 * without justification" — zod is not in package.json). The shape is
 * small enough that hand validation is faster + clearer than a schema
 * library.
 *
 * Public functions return discriminated unions so callers branch on
 * `.ok` and the type narrows correctly.
 */

import type {
  AnalyzeRequest,
  MeetingFeedFilters,
  MeetingFeedInput,
} from "./types";

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const MAX_NAME = 200;
const MAX_DESC = 2000;
const MAX_FILTERS = 50;
const MAX_FILTER_VALUE = 200;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((s) => typeof s === "string");
}

export function validateFilters(input: unknown): ValidationResult<MeetingFeedFilters> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "filters must be an object" };
  }
  const obj = input as Record<string, unknown>;
  const sender_match_raw = obj.sender_match ?? [];
  const subject_match_raw = obj.subject_match ?? [];
  if (!isStringArray(sender_match_raw)) {
    return { ok: false, error: "filters.sender_match must be string[]" };
  }
  if (!isStringArray(subject_match_raw)) {
    return { ok: false, error: "filters.subject_match must be string[]" };
  }
  if (sender_match_raw.length > MAX_FILTERS) {
    return { ok: false, error: `filters.sender_match has ${sender_match_raw.length} entries; max ${MAX_FILTERS}` };
  }
  if (subject_match_raw.length > MAX_FILTERS) {
    return { ok: false, error: `filters.subject_match has ${subject_match_raw.length} entries; max ${MAX_FILTERS}` };
  }
  // Trim, drop empties, cap individual entry length.
  const sender_match = sender_match_raw
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.slice(0, MAX_FILTER_VALUE));
  const subject_match = subject_match_raw
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.slice(0, MAX_FILTER_VALUE));

  let since: string | undefined;
  if (obj.since !== undefined && obj.since !== null) {
    if (typeof obj.since !== "string") {
      return { ok: false, error: "filters.since must be an ISO date string" };
    }
    const t = Date.parse(obj.since);
    if (!Number.isFinite(t)) {
      return { ok: false, error: "filters.since is not a parseable date" };
    }
    since = obj.since;
  }

  return {
    ok: true,
    value: {
      sender_match,
      subject_match,
      since,
    },
  };
}

export function validateFeedInput(input: unknown): ValidationResult<MeetingFeedInput> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "request body must be an object" };
  }
  const obj = input as Record<string, unknown>;

  if (typeof obj.name !== "string" || obj.name.trim().length === 0) {
    return { ok: false, error: "name is required" };
  }
  if (obj.name.length > MAX_NAME) {
    return { ok: false, error: `name exceeds ${MAX_NAME} chars` };
  }

  let description: string | null = null;
  if (obj.description !== undefined && obj.description !== null) {
    if (typeof obj.description !== "string") {
      return { ok: false, error: "description must be a string" };
    }
    if (obj.description.length > MAX_DESC) {
      return { ok: false, error: `description exceeds ${MAX_DESC} chars` };
    }
    description = obj.description;
  }

  if (obj.filters === undefined) {
    return { ok: false, error: "filters is required" };
  }
  const filters = validateFilters(obj.filters);
  if (!filters.ok) return filters;

  let is_enabled = true;
  if (obj.is_enabled !== undefined) {
    if (typeof obj.is_enabled !== "boolean") {
      return { ok: false, error: "is_enabled must be a boolean" };
    }
    is_enabled = obj.is_enabled;
  }

  return {
    ok: true,
    value: {
      name: obj.name.trim(),
      description,
      filters: filters.value,
      is_enabled,
    },
  };
}

export function validateFeedPatch(input: unknown): ValidationResult<Partial<MeetingFeedInput>> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "request body must be an object" };
  }
  const obj = input as Record<string, unknown>;
  const out: Partial<MeetingFeedInput> = {};

  if (obj.name !== undefined) {
    if (typeof obj.name !== "string" || obj.name.trim().length === 0) {
      return { ok: false, error: "name must be a non-empty string" };
    }
    if (obj.name.length > MAX_NAME) {
      return { ok: false, error: `name exceeds ${MAX_NAME} chars` };
    }
    out.name = obj.name.trim();
  }
  if (obj.description !== undefined) {
    if (obj.description === null) {
      out.description = null;
    } else if (typeof obj.description !== "string") {
      return { ok: false, error: "description must be a string or null" };
    } else if (obj.description.length > MAX_DESC) {
      return { ok: false, error: `description exceeds ${MAX_DESC} chars` };
    } else {
      out.description = obj.description;
    }
  }
  if (obj.filters !== undefined) {
    const f = validateFilters(obj.filters);
    if (!f.ok) return f;
    out.filters = f.value;
  }
  if (obj.is_enabled !== undefined) {
    if (typeof obj.is_enabled !== "boolean") {
      return { ok: false, error: "is_enabled must be a boolean" };
    }
    out.is_enabled = obj.is_enabled;
  }
  return { ok: true, value: out };
}

/* ------------------------------------------------------------------ */
/* Phase 5 — analyze request                                           */
/* ------------------------------------------------------------------ */

export function validateAnalyzeRequest(input: unknown): ValidationResult<AnalyzeRequest> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "request body must be an object" };
  }
  const obj = input as Record<string, unknown>;

  const subject_match_raw = obj.subject_match ?? [];
  const sender_match_raw = obj.sender_match ?? [];
  if (!isStringArray(subject_match_raw)) {
    return { ok: false, error: "subject_match must be string[]" };
  }
  if (!isStringArray(sender_match_raw)) {
    return { ok: false, error: "sender_match must be string[]" };
  }
  if (subject_match_raw.length > MAX_FILTERS) {
    return { ok: false, error: `subject_match exceeds ${MAX_FILTERS} entries` };
  }
  if (sender_match_raw.length > MAX_FILTERS) {
    return { ok: false, error: `sender_match exceeds ${MAX_FILTERS} entries` };
  }
  const subject_match = subject_match_raw
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.slice(0, MAX_FILTER_VALUE));
  const sender_match = sender_match_raw
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.slice(0, MAX_FILTER_VALUE));

  if (subject_match.length === 0 && sender_match.length === 0) {
    return {
      ok: false,
      error:
        "at least one of subject_match or sender_match must contain a value",
    };
  }

  let since: string | undefined;
  if (obj.since !== undefined && obj.since !== null && obj.since !== "") {
    if (typeof obj.since !== "string") {
      return { ok: false, error: "since must be an ISO date string" };
    }
    if (!Number.isFinite(Date.parse(obj.since))) {
      return { ok: false, error: "since is not a parseable date" };
    }
    since = obj.since;
  }

  let until: string | undefined;
  if (obj.until !== undefined && obj.until !== null && obj.until !== "") {
    if (typeof obj.until !== "string") {
      return { ok: false, error: "until must be an ISO date string" };
    }
    if (!Number.isFinite(Date.parse(obj.until))) {
      return { ok: false, error: "until is not a parseable date" };
    }
    until = obj.until;
  }

  if (since && until && Date.parse(since) > Date.parse(until)) {
    return { ok: false, error: "since must be on or before until" };
  }

  let include_attachments: boolean | undefined;
  if (obj.include_attachments !== undefined) {
    if (typeof obj.include_attachments !== "boolean") {
      return { ok: false, error: "include_attachments must be a boolean" };
    }
    include_attachments = obj.include_attachments;
  }

  return {
    ok: true,
    value: {
      subject_match,
      sender_match,
      since,
      until,
      include_attachments,
    },
  };
}
