/**
 * src/lib/ai/redaction, outbound LLM prompt PII/PHI guardrail.
 *
 * Redacts PII from text and message arrays before they leave the process
 * boundary to an LLM provider. Pure TypeScript, no runtime dependencies,
 * no network calls, fully deterministic.
 *
 * Supported kinds: email, phone, ssn, credit_card, ip, iban, api_key.
 *
 * Stable placeholders: the same raw value always maps to the same
 * placeholder within one call (e.g. the same email appearing twice
 * becomes [EMAIL_1] both times) so the model preserves coreference.
 * Numbering is per-kind and 1-based.
 *
 * Security invariant: original PII values are NEVER stored in hits,
 * logs, or return values, only the placeholder label travels out.
 *
 * ReDoS safety: every regex is linear (no nested quantifiers over
 * overlapping character classes). All are compiled once at module scope.
 * Input is bounded to MAX_REDACTION_INPUT_LEN before any pattern runs.
 */

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

export type RedactionKind =
  | "email"
  | "phone"
  | "ssn"
  | "credit_card"
  | "ip"
  | "iban"
  | "api_key";

export interface RedactionHit {
  kind: RedactionKind;
  /** Stable placeholder that replaced the original value, e.g. [EMAIL_1]. */
  placeholder: string;
}

export interface RedactionResult {
  /** Redacted text with PII replaced by stable placeholders like [EMAIL_1]. */
  text: string;
  /** What was redacted. NEVER includes the original PII value. */
  hits: RedactionHit[];
  redacted: boolean;
}

/* ------------------------------------------------------------------ */
/* Patterns                                                            */
/* ------------------------------------------------------------------ */

/* 16 KiB per input; LLM prompts should be far smaller, but a runaway
   user input must not drive catastrophic backtracking on long strings. */
const MAX_REDACTION_INPUT_LEN = 16 * 1024;

/*
 * EMAIL, local@domain.tld. Same shape as response-cache.ts EMAIL_RE.
 * Word boundary on the right; the @ sign provides a natural left anchor.
 */
const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g;

/*
 * PHONE: North American (NPA-NXX-XXXX) and E.164 (+countrycode digits).
 * NOTE: \b before an opening paren fails because ( is not a word char.
 * We use a negative lookbehind (?<!\d) instead of \b on the left, and
 * a negative lookahead (?!\d) on the right, to prevent matching sub-
 * sequences of longer digit strings while still matching (555) 867-5309.
 *
 * The area code is matched as an alternation (\(\d{3}\)|\d{3}), which is the
 * firm anchor the earlier version lacked: without it, the optional country
 * code \d{1,3} greedily ate the first digits of a bare 10-digit number and
 * desynced the rest, so "(555) 867-5309" matched nothing and a real phone
 * number leaked past the guardrail. The area-code alternation forces
 * backtracking to give those digits back so the full number is redacted.
 */
const PHONE_RE =
  /(?<!\d)(?:\+?\d{1,3}[\s.()-]{0,2})?(?:\(\d{3}\)|\d{3})[\s.()-]{0,2}\d{3}[\s.()-]{0,2}\d{4}(?!\d)/g;

/*
 * SSN, US Social Security Number: xxx-xx-xxxx (dashed only for the
 * explicit SSN form; bare 9-digit matches kept but must not conflict with
 * phone matches that already consume those digits).
 * Word boundaries prevent false matches on longer digit strings.
 */
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;

/*
 * CREDIT CARD, 13-19 digits optionally grouped by spaces, hyphens, or
 * nothing. Luhn-validated post-match to cut false positives (phone
 * numbers, UUIDs, SSNs, etc.).
 * (?<!\d) / (?!\d) boundary keeps this from matching mid-sequence.
 */
const CC_RE = /(?<!\d)(?:\d[ \-]?){12,18}\d(?!\d)/g;

/*
 * IPv4, dotted-quad, each octet 0-255.
 * Deterministic: \d{1,3} is bounded; no catastrophic overlap.
 */
const IP_RE =
  /\b(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)\b/g;

/*
 * IBAN, ISO 13616. Country code (2 alpha) + 2 check digits + up to 30
 * alphanumeric BBAN chars. Optional spaces every 4 chars (print format).
 * Total formatted length: 15-34 chars (plus spaces). Linear: fixed-width
 * groups.
 */
const IBAN_RE =
  /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/g;

/*
 * API_KEY, conservative patterns for well-known bearer token shapes.
 * We deliberately prefer false-negatives over false-positives to avoid
 * nuking normal text.
 *
 * Covered shapes:
 *   sk-...    : OpenAI / Anthropic style (sk- prefix + 20+ alphanum/dash)
 *   ghp_...   : GitHub personal access tokens
 *   xoxb-...  : Slack bot tokens
 *   Generic high-entropy tokens: 32+ hex chars or 40+ base64url chars
 *     that would be suspicious in prompt text. Anchored to word-boundary
 *     so normal words are never matched.
 *
 * Each branch is anchored and has a fixed prefix + minimum length so the
 * engine can fail-fast without backtracking.
 */
/* Provider-signature prefixes plus two generic shapes.
 *
 * The underscore-delimited Stripe/GitHub-app forms were missing: the generic
 * [A-Za-z0-9+/]{40,} arm cannot span an underscore, and the body after
 * `sk_live_` is typically ~33 characters, so a live Stripe secret key passed
 * through untouched. Those are the highest-harm thing anyone pastes into a
 * chat box by accident.
 *
 * Every arm is a fixed prefix followed by one bounded character class — linear,
 * no nested quantifiers, so the module's ReDoS guarantee holds. Prefix-anchored
 * rather than shape-guessed, which is what keeps precision high enough that
 * nobody turns the gate off. */
const API_KEY_RE =
  /\b(?:sk-[A-Za-z0-9\-_]{20,}|(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,}|xox[bapsr]-[A-Za-z0-9\-]{10,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9\-_]{35}|[A-Fa-f0-9]{32,}|[A-Za-z0-9+/]{40,}={0,2})\b/g;

/* ------------------------------------------------------------------ */
/* Luhn validation                                                     */
/* ------------------------------------------------------------------ */

/**
 * Standard Luhn algorithm. Returns true when the digit string passes.
 * Called on candidate credit-card matches (digits only, no separators).
 */
function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = parseInt(digits[i], 10);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/* ------------------------------------------------------------------ */
/* Internal context                                                    */
/* ------------------------------------------------------------------ */

interface PatternSpec {
  kind: RedactionKind;
  re: RegExp;
  /** Called with the raw match; return false to skip (e.g. Luhn failure). */
  validate?: (raw: string) => boolean;
}

const PATTERNS: PatternSpec[] = [
  { kind: "email", re: EMAIL_RE },
  { kind: "phone", re: PHONE_RE },
  { kind: "ssn", re: SSN_RE },
  {
    kind: "credit_card",
    re: CC_RE,
    validate: (raw) => {
      const digits = raw.replace(/[ \-]/g, "");
      if (digits.length < 13 || digits.length > 19) return false;
      return luhn(digits);
    },
  },
  { kind: "ip", re: IP_RE },
  { kind: "iban", re: IBAN_RE },
  { kind: "api_key", re: API_KEY_RE },
];

/**
 * Shared context for a single redaction call (either a standalone
 * redactText call or a redactMessages call spanning multiple fields).
 * The value→placeholder map guarantees coreference across fields when
 * the same context is passed through multiple redactFieldWithContext
 * invocations.
 */
interface RedactionContext {
  /** raw value → stable placeholder */
  valueMap: Map<string, string>;
  /** per-kind counter for placeholder numbering */
  kindCounters: Map<RedactionKind, number>;
  /** all distinct hits seen so far, keyed by placeholder */
  hitsByPlaceholder: Map<string, RedactionHit>;
}

function createContext(): RedactionContext {
  return {
    valueMap: new Map(),
    kindCounters: new Map(),
    hitsByPlaceholder: new Map(),
  };
}

function placeholderFor(
  ctx: RedactionContext,
  kind: RedactionKind,
  raw: string,
): string {
  const existing = ctx.valueMap.get(raw);
  if (existing !== undefined) return existing;
  const n = (ctx.kindCounters.get(kind) ?? 0) + 1;
  ctx.kindCounters.set(kind, n);
  const label = `[${kind.toUpperCase()}_${n}]`;
  ctx.valueMap.set(raw, label);
  return label;
}

/**
 * Core redaction pass over a single bounded string, using the supplied
 * context for stable coreference. Mutates `ctx` (adds newly seen
 * values/hits). Returns the redacted text and an array of new hits
 * (hits seen for the first time in this field).
 */
function redactFieldWithContext(
  bounded: string,
  ctx: RedactionContext,
  /* Which kinds to act on. Undefined means all of them, which is what every
     existing caller gets. */
  kinds?: ReadonlySet<RedactionKind>,
): { text: string; fieldHits: RedactionHit[]; redacted: boolean } {
  type Span = {
    start: number;
    end: number;
    placeholder: string;
    kind: RedactionKind;
  };
  const spans: Span[] = [];

  for (const { kind, re, validate } of PATTERNS) {
    if (kinds && !kinds.has(kind)) continue;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(bounded)) !== null) {
      const raw = m[0];
      if (validate && !validate(raw)) continue;
      const placeholder = placeholderFor(ctx, kind, raw);
      spans.push({
        start: m.index,
        end: m.index + raw.length,
        placeholder,
        kind,
      });
    }
  }

  if (spans.length === 0) {
    return { text: bounded, fieldHits: [], redacted: false };
  }

  /* Sort by start; resolve overlaps by keeping earliest start. */
  spans.sort((a, b) => a.start - b.start || b.end - a.end);

  const outputParts: string[] = [];
  const fieldHits: RedactionHit[] = [];
  let cursor = 0;

  for (const span of spans) {
    if (span.start < cursor) continue; /* overlapped by earlier span */
    outputParts.push(bounded.slice(cursor, span.start));
    outputParts.push(span.placeholder);
    cursor = span.end;
    if (!ctx.hitsByPlaceholder.has(span.placeholder)) {
      const hit: RedactionHit = {
        kind: span.kind,
        placeholder: span.placeholder,
      };
      ctx.hitsByPlaceholder.set(span.placeholder, hit);
      fieldHits.push(hit);
    }
  }
  outputParts.push(bounded.slice(cursor));

  return {
    text: outputParts.join(""),
    fieldHits,
    redacted: true,
  };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Redact a single string.
 *
 * Runs all pattern specs in order over the (bounded) input, collecting
 * span replacements, then applies them in a single left-to-right pass so
 * patterns discovered earlier do not interfere with offset arithmetic for
 * patterns found later. A value→placeholder map provides stable
 * coreference: the same raw value always maps to the same label within
 * one call.
 */
export function redactText(
  input: string,
  kinds?: ReadonlySet<RedactionKind>,
): RedactionResult {
  if (!input) return { text: input, hits: [], redacted: false };

  const bounded =
    input.length > MAX_REDACTION_INPUT_LEN
      ? input.slice(0, MAX_REDACTION_INPUT_LEN)
      : input;

  const ctx = createContext();
  const { text, fieldHits, redacted } = redactFieldWithContext(bounded, ctx, kinds);
  return { text, hits: fieldHits, redacted };
}

/**
 * Redact a full message array and an optional system prompt.
 *
 * sensitivity gates:
 *   "public"           → passthrough, hits=[], count=0
 *   "pii" | "phi" | undefined → redact all fields (phi and pii use the
 *                       same full pattern set; phi is a superset in intent
 *                       but identical in patterns at this revision)
 *
 * Returns new arrays, inputs are never mutated.
 *
 * A SINGLE shared context spans the system prompt and all messages so
 * the same raw value maps to the same placeholder everywhere (coreference
 * across turns), and counting is per-kind across the whole batch.
 *
 * Hits are deduped: the same placeholder is counted once in the returned
 * `hits` list regardless of how many messages it appears in.
 * `count` equals hits.length (unique distinct PII instances found).
 */
export function redactMessages(
  messages: { role: string; content: string }[],
  system: string | undefined,
  sensitivity: "public" | "pii" | "phi" | undefined,
  /* Restrict redaction to these kinds. Undefined means all of them, which is
     what every caller predating this parameter gets. */
  kinds?: ReadonlySet<RedactionKind>,
): {
  messages: { role: string; content: string }[];
  system: string | undefined;
  hits: RedactionHit[];
  count: number;
} {
  /* Public data → passthrough. */
  if (sensitivity === "public") {
    return {
      messages: messages.map((m) => ({ ...m })),
      system,
      hits: [],
      count: 0,
    };
  }

  /* Shared context across all fields for stable cross-field coreference. */
  const ctx = createContext();

  /* Redact system prompt. */
  let redactedSystem: string | undefined;
  if (system !== undefined) {
    const bounded =
      system.length > MAX_REDACTION_INPUT_LEN
        ? system.slice(0, MAX_REDACTION_INPUT_LEN)
        : system;
    redactedSystem = redactFieldWithContext(bounded, ctx, kinds).text;
  } else {
    redactedSystem = undefined;
  }

  /* Redact each message (new objects; no mutation). */
  const redactedMessages = messages.map((msg) => {
    const bounded =
      msg.content.length > MAX_REDACTION_INPUT_LEN
        ? msg.content.slice(0, MAX_REDACTION_INPUT_LEN)
        : msg.content;
    const { text } = redactFieldWithContext(bounded, ctx, kinds);
    return { role: msg.role, content: text };
  });

  const hits = Array.from(ctx.hitsByPlaceholder.values());
  return {
    messages: redactedMessages,
    system: redactedSystem,
    hits,
    count: hits.length,
  };
}


/**
 * Kinds that have no legitimate reason to reach a model, ever.
 *
 * WHY THIS IS A SUBSET AND NOT "EVERYTHING"
 *
 * Instinct is an internal agency OS. "What is Jorge's email?", "call the
 * Monmouth concierge", "who is on the Porsche account" are the product working
 * as intended, and the directory is a core feature. Redacting email, phone and
 * IP would not harden the assistant, it would break it — and a guardrail that
 * breaks the tool gets switched off, which leaves you with neither.
 *
 * A credential, an SSN, a card number or an IBAN is different: there is no
 * question a person can ask this product where sending one to a third-party
 * model is the right answer. Those are almost always pasted by accident, into
 * a chat box, as part of a log or a document dump. That is the realistic
 * incident here, and this is the class that stops it.
 *
 * Callers who genuinely need the full set (the OGIAM ledger, agent actions)
 * keep passing nothing and keep getting everything.
 */
export const NEVER_SEND_KINDS: ReadonlySet<RedactionKind> = new Set([
  "api_key",
  "ssn",
  "credit_card",
  "iban",
]);
