/**
 * Default secret/PII scrub applied to EVERY prompt before it reaches a model -
 * regardless of the client's policy, even "full". A client who allows model data
 * still never means "send our AWS keys / a customer's SSN to the LLM"; scrubbing
 * recognizable secret and PII shapes is the floor under the "won't leak data to
 * the LLM" promise. Over-redacting a prompt is safe (the model just sees
 * [REDACTED]); under-redacting is the harm we prevent, so this errs toward
 * redaction.
 *
 * Reuses the precision-first provider token signatures (KEY_SIGNATURES) and adds
 * the shapes that show up in logs/source the CI-fixer forwards: more provider
 * tokens, bearer/Authorization headers, private keys, JWTs, and common PII.
 */
import { KEY_SIGNATURES } from "@/lib/ai-surface/detect";

/** Secret shapes to scrub. KEY_SIGNATURES + the ones that appear in CI logs and
 *  source files (GitHub, AWS, Slack, GitLab, Stripe, bearer headers, PEM keys). */
const SECRET_PATTERNS: RegExp[] = [
  ...KEY_SIGNATURES.map((k) => k.re),
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,               // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g,             // GitHub fine-grained PAT
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,                 // GitLab PAT
  /\bAKIA[0-9A-Z]{16}\b/g,                         // AWS access key id
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,             // Slack token
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g,        // Stripe secret key
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, // PEM
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{20,}/g,        // bearer header value
  /\b(?:password|passwd|secret|token|api[_-]?key|client[_-]?secret)\b\s*[=:]\s*['"]?[^\s'"`]{6,}/gi, // assignment
];

/** PII shapes: email, US SSN, credit-card-length digit runs. Precision-leaning to
 *  avoid mangling normal prose (SSN/card require the punctuation/length shape). */
const PII_PATTERNS: RegExp[] = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, // email
  /\b\d{3}-\d{2}-\d{4}\b/g,                              // US SSN
  /\b(?:\d[ -]?){13,16}\b/g,                             // credit-card-ish run
];

export interface ScrubResult {
  text: string;
  /** How many redactions were made - surfaced in the gate transparency so the
   *  client can SEE that data was scrubbed before any model saw it. */
  count: number;
}

/** Scrub secrets + PII from text bound for a model. Never throws. */
export function scrubForModel(text: string): ScrubResult {
  let out = text;
  let count = 0;
  for (const re of [...SECRET_PATTERNS, ...PII_PATTERNS]) {
    out = out.replace(re, () => {
      count++;
      return "[REDACTED]";
    });
  }
  return { text: out, count };
}
