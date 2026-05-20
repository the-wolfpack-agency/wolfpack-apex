/**
 * Upload-to-Brain data-quality filter.
 *
 * Gate fired BEFORE the existing `ingest()` pipeline in the new
 * /api/brain/upload route (the "user-driven Brain ingest" surface
 * served by the UploadToBrainWidget). Catches bad-data inputs early
 * so they never become indexed chunks, audit-trail noise, or
 * embedding spend.
 *
 * Seven gates, all on by default:
 *   1. File-type allowlist (MIME + size sanity).
 *   2. Hard size cap (10 MB).
 *   3. Minimum content (≥50 non-whitespace chars AND ≥10 word tokens
 *      after text extraction).
 *   4. Secret scan (AWS / Google / Stripe / Anthropic / OpenAI / JWT).
 *   5. PII scan — credit-card (Luhn) blocks; email+phone combo flags
 *      (warning, not block).
 *   6. Duplicate (SHA-256 of normalized text — consults the existing
 *      brain_documents.sha256 column via findDocumentBySha so re-
 *      uploads of identical content are caught at the gate, not after
 *      ingest writes a duplicate analytics trail).
 *   7. Repetition / low-signal heuristic — top-3 words >50% of total.
 *
 * Pure-TS, side-effect-free except for the optional dedup DB lookup.
 * Every gate's failure name appears in the `reasons` array so the UI
 * (and the brain.upload_rejected analytics event) surfaces *why* the
 * upload was rejected.
 */

import { createHash } from "node:crypto";
import { findDocumentBySha } from "./repo";

// ── Allowlist ────────────────────────────────────────────────────────

/**
 * MIME types accepted by the user-driven upload surface. Narrower than
 * the legacy /api/brain/ingest endpoint's classifier — this is the
 * deliberate "team uploads canonical knowledge" funnel, not the
 * grab-bag attach-anything surface.
 */
export const UPLOAD_FILTER_ALLOWED_MIME_TYPES: readonly string[] = [
  "text/plain",
  "text/markdown",
  "text/html",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/json",
  "text/csv",
];

/** 10 MB cap — matches the user-facing widget hint. The lib-level
 *  ingest pipeline tolerates 25 MB, but the deliberate-upload surface
 *  is intentionally tighter to discourage video / archive dumps. */
export const UPLOAD_FILTER_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

// ── Filter input / output contracts ─────────────────────────────────

export interface UploadFilterInput {
  /** Filename as submitted by the client (used to derive a fallback
   *  MIME via extension when the browser sent application/octet-stream). */
  filename: string;
  /** Declared MIME type from the multipart form. */
  mimeType: string;
  /** Raw file bytes. */
  buffer: Buffer;
  /**
   * Plaintext extracted from `buffer` BEFORE running the filter. The
   * caller is responsible for extraction so this module stays a pure
   * gate (no extractor side effects). For text-shaped MIME types the
   * caller can just hand us `buffer.toString("utf8")`. For PDF/DOCX
   * the caller should run the existing brain/extractor first and pass
   * the result here.
   *
   * When `undefined`, the minimum-content gate is skipped (the legacy
   * ingest pipeline's extractor still runs downstream and can still
   * reject; but the filter can't measure content quality without text).
   */
  extractedText?: string;
  /** Optional override: when true, skip the dedup gate. Used by tests
   *  + the rare admin "force-reupload" flow. Default false. */
  skipDedup?: boolean;
  /** Optional override: when false, the credit-card / contact-card PII
   *  scan is skipped. Defaults to true. */
  scanPII?: boolean;
  /** Optional override: when true, skip the minimum-content gate
   *  (≥50 non-whitespace chars + ≥10 tokens). Use for explicit
   *  user-paste flows where the user typed the text themselves and
   *  has already opted into "yes, add even this short note." Defaults
   *  to false so file uploads still get the gate. */
  skipMinContent?: boolean;
}

export interface UploadFilterSuccess {
  ok: true;
  /** SHA-256 (hex) of the normalized text. Stable across whitespace
   *  collapse so semantically-identical uploads dedupe even with
   *  trivial reformatting. */
  contentHash: string;
  /** The whitespace-collapsed text used for hashing + content metrics. */
  normalizedText: string;
  /** Non-blocking warnings (e.g. email + phone proximity). UI may
   *  surface these as caution chips. */
  warnings: string[];
}

export interface UploadFilterRejection {
  ok: false;
  /** Gate-name strings. Stable identifiers — safe for analytics +
   *  rendering as chips in the widget. */
  reasons: string[];
  /** Hash if computable (extractor ran); useful for analytics so
   *  the learning loop can see "this hash got rejected on these
   *  gates." May be absent when the buffer never got far enough. */
  contentHash?: string;
}

export type UploadFilterResult = UploadFilterSuccess | UploadFilterRejection;

// ── Gate 1: file-type allowlist ─────────────────────────────────────

const EXTENSION_TO_MIME: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  html: "text/html",
  htm: "text/html",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  json: "application/json",
  csv: "text/csv",
};

/**
 * Resolve a usable MIME type from the declared type + filename. Browsers
 * sometimes send `application/octet-stream` for known types when the OS
 * doesn't have a handler registered — falling back to extension catches
 * those without weakening the allowlist (the extension still has to map
 * to an allowed type).
 */
export function resolveMimeType(filename: string, declared: string): string {
  const d = (declared || "").toLowerCase().trim();
  if (UPLOAD_FILTER_ALLOWED_MIME_TYPES.includes(d)) return d;
  const ext = filename.toLowerCase().split(".").pop();
  if (ext && EXTENSION_TO_MIME[ext]) return EXTENSION_TO_MIME[ext];
  return d;
}

function isAllowedMime(mime: string): boolean {
  return UPLOAD_FILTER_ALLOWED_MIME_TYPES.includes(mime);
}

// ── Gate 4: secret patterns ─────────────────────────────────────────

interface SecretPattern {
  label: string;
  re: RegExp;
}

/**
 * Common high-confidence secret patterns. Anchoring is intentionally
 * loose — a leaked key inside a longer document still trips the gate.
 * Order doesn't matter (we run all of them and accumulate matches).
 */
const SECRET_PATTERNS: SecretPattern[] = [
  { label: "aws_access_key", re: /AKIA[0-9A-Z]{16}/g },
  { label: "google_api_key", re: /AIza[0-9A-Za-z\-_]{35}/g },
  { label: "stripe_live_key", re: /sk_live_[0-9a-zA-Z]{24,}/g },
  /* JWT — three base64url segments. The middle segment must start with
   * eyJ (base64 of "{\"...") so we don't trip on random dot-separated
   * tokens. */
  {
    label: "jwt_token",
    re: /eyJ[A-Za-z0-9_=-]{20,}\.eyJ[A-Za-z0-9_=-]{20,}\.[A-Za-z0-9._=-]+/g,
  },
  { label: "anthropic_key", re: /sk-ant-[A-Za-z0-9\-_]{20,}/g },
  /* OpenAI key — `sk-` followed by 20+ alphanumerics. Run AFTER the
   * Stripe pattern so `sk_live_*` (underscore-prefixed) doesn't double
   * count, and AFTER Anthropic so `sk-ant-*` only counts as Anthropic.
   * Negative lookahead enforces that. */
  { label: "openai_key", re: /sk-(?!ant-)[A-Za-z0-9]{20,}/g },
];

function scanForSecrets(text: string): string[] {
  const found = new Set<string>();
  for (const { label, re } of SECRET_PATTERNS) {
    if (re.test(text)) found.add(label);
    re.lastIndex = 0; // /g state reset for the next call
  }
  return [...found];
}

// ── Gate 5: PII scan ────────────────────────────────────────────────

const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_RE =
  /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
/** 13–19 digit runs allowing single space / hyphen separators. */
const CREDIT_CARD_RE = /\b(?:\d[ -]?){12,18}\d\b/g;

/** Luhn-validate a card-shaped digit run. Strips spaces / hyphens
 *  first; rejects anything outside 13–19 digits. */
export function luhnValid(candidate: string): boolean {
  const digits = candidate.replace(/[\s-]/g, "");
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

interface PiiScanResult {
  hardBlocks: string[];
  warnings: string[];
}

/**
 * Returns:
 *   - `hardBlocks` — gate names that should reject (Luhn-valid credit
 *     card; SSN).
 *   - `warnings`  — non-blocking flags (email + phone within 50 chars
 *     of each other → likely contact card; the user can still upload
 *     but the UI surfaces a chip).
 */
function scanForPII(text: string): PiiScanResult {
  const hardBlocks: string[] = [];
  const warnings: string[] = [];

  // SSN — hard block.
  if (SSN_RE.test(text)) hardBlocks.push("ssn");
  SSN_RE.lastIndex = 0;

  // Credit card — Luhn-validated hard block.
  const cardMatches = text.match(CREDIT_CARD_RE) ?? [];
  if (cardMatches.some((m) => luhnValid(m))) {
    hardBlocks.push("credit_card");
  }

  // Email + phone within 50 chars → contact-card warning.
  const emails = matchAllPositions(text, EMAIL_RE);
  const phones = matchAllPositions(text, PHONE_RE);
  outer: for (const ePos of emails) {
    for (const pPos of phones) {
      if (Math.abs(pPos - ePos) <= 50) {
        warnings.push("contact_card_pii");
        break outer;
      }
    }
  }

  return { hardBlocks, warnings };
}

function matchAllPositions(text: string, re: RegExp): number[] {
  const positions: number[] = [];
  const cloned = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = cloned.exec(text)) !== null) {
    positions.push(m.index);
    if (m.index === cloned.lastIndex) cloned.lastIndex++;
  }
  return positions;
}

// ── Gate 7: repetition / low-signal ─────────────────────────────────

/**
 * Returns `true` when the top 3 word tokens make up >50% of the total
 * token count — a signature of placeholder / templated / spam-ish
 * uploads (lorem ipsum, "test test test", repeated headers).
 * Skipped for very short inputs (< 30 tokens) because tiny docs
 * trivially fail the heuristic by accident.
 */
export function isLowSignalRepetitive(text: string): boolean {
  const tokens = text
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 0);
  if (tokens.length < 30) return false;
  const counts = new Map<string, number>();
  for (const t of tokens) {
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const top3Sum = [...counts.values()]
    .sort((a, b) => b - a)
    .slice(0, 3)
    .reduce((acc, n) => acc + n, 0);
  return top3Sum / tokens.length > 0.5;
}

// ── Normalization + hashing ─────────────────────────────────────────

/** Collapse all whitespace to single spaces, trim, lowercase the
 *  hashed substrate so semantically-identical content collides. */
export function normalizeText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function hashNormalized(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex");
}

// ── The filter entrypoint ───────────────────────────────────────────

/**
 * Run every gate. Returns the first decisive outcome:
 *   - reject when any hard gate fails (gates accumulate so the UI can
 *     surface multiple reasons in one rejection).
 *   - accept with optional warnings otherwise.
 *
 * Never throws. DB lookup errors in the dedup gate downgrade to a
 * warning rather than a failure — better to admit a duplicate than
 * lose the upload to a transient DB blip.
 */
export async function runUploadFilter(
  input: UploadFilterInput,
): Promise<UploadFilterResult> {
  const reasons: string[] = [];
  const warnings: string[] = [];

  const mime = resolveMimeType(input.filename, input.mimeType);

  // Gate 1: MIME allowlist.
  if (!isAllowedMime(mime)) {
    reasons.push("disallowed_file_type");
  }

  // Gate 2: hard size cap.
  if (!input.buffer || input.buffer.length === 0) {
    reasons.push("empty_file");
  } else if (input.buffer.length > UPLOAD_FILTER_MAX_FILE_SIZE_BYTES) {
    reasons.push("file_too_large");
  }

  // If we can't go further (no MIME + no bytes), bail.
  if (reasons.length > 0 && !input.extractedText) {
    return { ok: false, reasons };
  }

  const text = (input.extractedText ?? "").toString();
  const normalized = normalizeText(text);
  const tokenCount = normalized
    ? normalized.split(/\s+/).filter((t) => t.length > 0).length
    : 0;
  const nonWhitespaceCharCount = normalized.replace(/\s/g, "").length;

  // Gate 3: minimum content. Skipped for explicit paste flows where
  // the user typed it themselves — they know the note is short.
  if (text.length > 0 && !input.skipMinContent) {
    if (nonWhitespaceCharCount < 50 || tokenCount < 10) {
      reasons.push("insufficient_content");
    }
  }

  // Gate 4: secrets.
  if (text.length > 0) {
    const secretLabels = scanForSecrets(text);
    for (const l of secretLabels) reasons.push(`secret_${l}`);
  }

  // Gate 5: PII.
  if ((input.scanPII ?? true) && text.length > 0) {
    const pii = scanForPII(text);
    for (const l of pii.hardBlocks) reasons.push(`pii_${l}`);
    for (const w of pii.warnings) warnings.push(w);
  }

  // Gate 7: repetition heuristic.
  if (text.length > 0 && isLowSignalRepetitive(text)) {
    reasons.push("low_signal_repetitive");
  }

  const contentHash = text.length > 0 ? hashNormalized(normalized) : hashNormalized(input.buffer.toString("base64"));

  // Gate 6: dedup (DB lookup). Run LAST so cheaper gates short-circuit
  // first — no point hitting Postgres if the MIME was already wrong.
  if (!input.skipDedup && reasons.length === 0) {
    try {
      const existing = await findDocumentBySha(contentHash);
      if (existing) reasons.push("duplicate_content");
    } catch {
      /* Transient DB blip: warn but don't block. The downstream ingest
       * still calls findDocumentBySha so a duplicate that slips through
       * here gets caught + returned as `duplicate_of` rather than
       * double-indexed. */
      warnings.push("dedup_lookup_unavailable");
    }
  }

  if (reasons.length > 0) {
    return { ok: false, reasons, contentHash };
  }
  return {
    ok: true,
    contentHash,
    normalizedText: normalized,
    warnings,
  };
}
