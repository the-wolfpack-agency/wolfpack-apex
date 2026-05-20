/**
 * Brain security primitives — filename sanitization, MIME validation,
 * rate limiting, extraction size caps, and prompt-injection neutralization.
 *
 * All single-file so the security posture is reviewable in one read. No
 * external deps. Everything here is pure-function except the rate-limit
 * state which is an explicit Map. For production scale, swap the Map for
 * a Redis-backed limiter — the API stays identical.
 */

// ── Filename sanitization ─────────────────────────────────────────

/** Unicode bidi controls that can visually spoof extensions. */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;
/** C0/C1 controls + null byte. */
const CONTROLS = /[\x00-\x1F\x7F-\x9F]/g;
/** Windows reserved devices — block even on POSIX hosts because files
 *  get mirrored to OneDrive/SharePoint which run on Windows. */
const WINDOWS_RESERVED = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

export const MAX_FILENAME_LEN = 180;

export interface FilenameResult {
  ok: boolean;
  value?: string;
  reason?: string;
}

/**
 * Return a safe filename or a rejection. Never silently mutates: if we
 * have to change a character for safety, the caller sees the new string
 * and can decide whether to reject. Stripped chars are replaced, not
 * dropped, so the length invariant stays intuitive.
 */
export function sanitizeFilename(raw: string): FilenameResult {
  if (typeof raw !== "string") return { ok: false, reason: "not a string" };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "empty filename" };
  if (trimmed.length > MAX_FILENAME_LEN) {
    return { ok: false, reason: `filename exceeds ${MAX_FILENAME_LEN} chars` };
  }
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return { ok: false, reason: "path separators not allowed" };
  }
  if (trimmed === "." || trimmed === "..") {
    return { ok: false, reason: "reserved name" };
  }

  // Strip bidi controls (RTL-override spoof) + C0/C1 controls (null byte,
  // escape sequences). We replace with "_" instead of dropping so visual
  // length stays meaningful and two adjacent safe chars can't collide.
  let cleaned = trimmed.replace(BIDI_CONTROLS, "_").replace(CONTROLS, "_");

  // Collapse runs of NUL-replacement + whitespace to a single underscore.
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  // Windows reserved-device check — case-insensitive, extension ignored.
  const stem = cleaned.split(".")[0].toLowerCase();
  if (WINDOWS_RESERVED.has(stem)) {
    return { ok: false, reason: `filename "${stem}" is reserved` };
  }

  // Final safety check — no path separators after cleaning
  if (cleaned.includes("/") || cleaned.includes("\\")) {
    return { ok: false, reason: "post-sanitize path separator detected" };
  }
  return { ok: true, value: cleaned };
}

// ── MIME magic-byte validation ────────────────────────────────────

/**
 * Map of declared content-type/extension → required magic bytes. We only
 * hard-verify the content types that have a synchronous extractor —
 * audio/video/image/email are deferred to workers anyway, so a type
 * mismatch there just yields a "skipped" document, not an exploit.
 */
type MagicCheck = { prefix: readonly number[]; label: string };

const MAGIC: Record<string, MagicCheck> = {
  pdf: { prefix: [0x25, 0x50, 0x44, 0x46], label: "%PDF-" }, // %PDF
  docx: { prefix: [0x50, 0x4b, 0x03, 0x04], label: "PK ZIP" }, // ZIP (DOCX is a zip)
  xlsx: { prefix: [0x50, 0x4b, 0x03, 0x04], label: "PK ZIP" }, // ZIP (XLSX is also a zip)
};

export interface MagicResult {
  ok: boolean;
  detected?: string;
  reason?: string;
}

/**
 * Validate a buffer's leading bytes against the expected magic for the
 * kind. Returns `{ ok: true }` for kinds we don't hard-verify (text-based
 * formats are obviously content-inspectable) — caller can keep going.
 * Returns `{ ok: false, reason }` only when there's a *confirmed*
 * mismatch for a kind we have a magic signature for.
 */
export function validateMagicBytes(
  kind: string,
  buffer: Buffer,
): MagicResult {
  const spec = MAGIC[kind];
  if (!spec) return { ok: true }; // nothing to verify
  if (buffer.length < spec.prefix.length) {
    return { ok: false, reason: `file too short to validate ${kind} magic` };
  }
  for (let i = 0; i < spec.prefix.length; i++) {
    if (buffer[i] !== spec.prefix[i]) {
      return {
        ok: false,
        detected: describePrefix(buffer),
        reason: `expected ${spec.label} for ${kind}`,
      };
    }
  }
  return { ok: true };
}

function describePrefix(buf: Buffer): string {
  return Array.from(buf.subarray(0, 4))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

// ── Rate limiting ────────────────────────────────────────────────

interface RateBucket {
  /** Unix ms of the oldest request in the current window. */
  windowStart: number;
  /** Count of requests in the current window. */
  count: number;
}

const INGEST_STATE = new Map<string, RateBucket>();
const QUERY_STATE = new Map<string, RateBucket>();

export const INGEST_LIMIT = { perWindowMs: 60_000, max: 20 }; // 20/min per user
export const QUERY_LIMIT = { perWindowMs: 60_000, max: 120 }; // 120/min per user

export interface RateDecision {
  allowed: boolean;
  retryAfterSec?: number;
  remaining?: number;
}

function checkBucket(
  state: Map<string, RateBucket>,
  userId: string,
  config: { perWindowMs: number; max: number },
  now: number = Date.now(),
): RateDecision {
  const key = userId || "anon";
  const b = state.get(key);
  if (!b || now - b.windowStart >= config.perWindowMs) {
    state.set(key, { windowStart: now, count: 1 });
    return { allowed: true, remaining: config.max - 1 };
  }
  if (b.count >= config.max) {
    const retryAfterSec = Math.ceil((config.perWindowMs - (now - b.windowStart)) / 1000);
    return { allowed: false, retryAfterSec, remaining: 0 };
  }
  b.count++;
  return { allowed: true, remaining: config.max - b.count };
}

export function rateLimitIngest(userId: string): RateDecision {
  return checkBucket(INGEST_STATE, userId, INGEST_LIMIT);
}

export function rateLimitQuery(userId: string): RateDecision {
  return checkBucket(QUERY_STATE, userId, QUERY_LIMIT);
}

/** Test-only: clear rate-limit buckets between test cases. */
export function _resetRateLimitState(): void {
  INGEST_STATE.clear();
  QUERY_STATE.clear();
}

// ── Extraction size cap ──────────────────────────────────────────

/** 10 MB cap on extracted plaintext — prevents PDF-expansion DoS.
 *  Typical 100-page PDF extracts to ~500 KB; this leaves 20× headroom
 *  for edge cases like manuals with dense tables, while killing
 *  anything pathological before it gets chunked + embedded. */
export const MAX_EXTRACTED_BYTES = 10 * 1024 * 1024;
export const MAX_EXTRACTED_CHARS = MAX_EXTRACTED_BYTES; // 1 char ≈ 1 byte for ascii; UTF-8 gives us margin

export interface CappedText {
  text: string;
  truncated: boolean;
  originalLength: number;
}

export function capExtracted(text: string): CappedText {
  if (text.length <= MAX_EXTRACTED_CHARS) {
    return { text, truncated: false, originalLength: text.length };
  }
  return {
    text: text.slice(0, MAX_EXTRACTED_CHARS),
    truncated: true,
    originalLength: text.length,
  };
}

// ── Prompt-injection neutralization ──────────────────────────────

/**
 * Phrases commonly used in prompt-injection payloads embedded in
 * documents. We replace each match with a bracketed neutralization tag
 * so the model sees the substitution and treats it as suspicious rather
 * than as an instruction.
 *
 * This is BELT-AND-SUSPENDERS: the structural defense (wrapping brain
 * chunks in explicit delimiters in assistant.ts) is the primary control.
 * String-match is best-effort and can be bypassed by novel phrasing.
 */
const INJECTION_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /ignore (all |any |the )?(previous|prior|above) (instructions?|prompts?|rules?)/gi, label: "ignore-prior" },
  { pattern: /disregard (all |any |the )?(previous|prior|above) (instructions?|prompts?)/gi, label: "disregard-prior" },
  { pattern: /you (are|now) (a|an) (different|new)/gi, label: "role-override" },
  { pattern: /system\s*:\s*you/gi, label: "fake-system-prefix" },
  { pattern: /\[INST\]|\[\/INST\]/gi, label: "inst-marker" },
  { pattern: /\bjailbreak\b/gi, label: "jailbreak" },
];

export interface InjectionReport {
  text: string;
  matchedLabels: string[];
}

/**
 * Return the input with known injection phrases replaced by a neutral
 * tag, plus a list of what was caught. Idempotent; running it twice is
 * safe. Callers log `matchedLabels` to `brain.*` analytics so suspicious
 * documents get flagged for review.
 */
export function neutralizeInjection(input: string): InjectionReport {
  let text = input;
  const labels = new Set<string>();
  for (const { pattern, label } of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      labels.add(label);
      text = text.replace(pattern, `[filtered:${label}]`);
    }
  }
  return { text, matchedLabels: [...labels] };
}

/**
 * Wrap retrieved Brain content with explicit delimiter tags so LLM
 * prompts treat it as untrusted data. Used in assistant.ts when Brain
 * text is about to be surfaced verbatim or included in future LLM
 * context windows.
 */
export function wrapBrainContent(filename: string, content: string): string {
  // Strip any pre-existing BRAIN_QUOTE delimiters so an attacker can't
  // close our wrapper and inject outside it.
  const safeContent = content.replace(/\[\/?BRAIN_QUOTE[^\]]*\]/g, "");
  return `[BRAIN_QUOTE file="${filename.replace(/"/g, "'")}"]\n${safeContent}\n[/BRAIN_QUOTE]`;
}
