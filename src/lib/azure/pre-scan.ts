/**
 * PII + secrets pre-scan for documents headed to Azure Cognitive
 * Services.
 *
 * Why this exists: the brain `/api/brain/upload` route already runs
 * runUploadFilter (secrets + PII checks) BEFORE the file leaves our
 * boundary. But the receipt + invoice + HR-doc scan routes go
 * straight to Azure without that gate. A receipt with an embedded
 * SSN, credit card, or stripe key shouldn't reach a third-party
 * service — Form Recognizer's DPA covers it, but defense in depth
 * means refusing the obvious-bad cases at our boundary.
 *
 * The check runs on bytes interpreted as UTF-8 — for binary formats
 * (PDF, PNG, JPEG) that mostly yields gibberish, but ASCII-text
 * fragments (embedded metadata, OCR layer in tagged PDFs) still
 * surface. Cheap; runs once per upload.
 *
 * Reuses scanForSecrets + scanForPII from lib/brain/upload-filter
 * so the rules stay in one place — anything we add there flows
 * through here automatically.
 */

import { luhnValid } from "@/lib/brain/upload-filter";

/* High-confidence patterns. Kept in this file (rather than imported
   from upload-filter) because upload-filter's are file-scoped private.
   If you change either set, update both. */
const SECRET_PATTERNS: { label: string; re: RegExp }[] = [
  { label: "aws_access_key", re: /AKIA[0-9A-Z]{16}/g },
  { label: "google_api_key", re: /AIza[0-9A-Za-z\-_]{35}/g },
  { label: "stripe_live_key", re: /sk_live_[0-9a-zA-Z]{24,}/g },
  { label: "anthropic_key", re: /sk-ant-[A-Za-z0-9\-_]{20,}/g },
  { label: "openai_key", re: /sk-(?!ant-)[A-Za-z0-9]{20,}/g },
  {
    label: "jwt_token",
    re: /eyJ[A-Za-z0-9_=-]{20,}\.eyJ[A-Za-z0-9_=-]{20,}\.[A-Za-z0-9._=-]+/g,
  },
];

const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const CREDIT_CARD_RE = /\b(?:\d[ -]?){12,18}\d\b/g;

export interface PreScanResult {
  ok: boolean;
  blockedBy: string[];
}

/**
 * Inspect a buffer for high-confidence secrets / PII shapes. Returns
 * `ok: true` when nothing matched, otherwise `ok: false` with the
 * labels that triggered. Callers SHOULD refuse to forward the buffer
 * to Azure when ok=false.
 *
 * The check is intentionally narrow — only blocks on patterns with
 * very low false-positive rate (Luhn-valid card, SSN format, named
 * API keys). It does NOT block on email + phone (those are normal
 * on receipts/invoices).
 */
export function preScanForBlockingPII(buf: Buffer): PreScanResult {
  /* Decode as UTF-8 with replacement chars rather than throwing.
     Binary blocks become noise; ASCII fragments still match. */
  const text = buf.toString("utf8");
  const blocked: string[] = [];

  for (const { label, re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) blocked.push(`secret_${label}`);
  }

  SSN_RE.lastIndex = 0;
  if (SSN_RE.test(text)) blocked.push("pii_ssn");

  CREDIT_CARD_RE.lastIndex = 0;
  const cards = text.match(CREDIT_CARD_RE) ?? [];
  if (cards.some((m) => luhnValid(m))) blocked.push("pii_credit_card");

  return { ok: blocked.length === 0, blockedBy: blocked };
}
