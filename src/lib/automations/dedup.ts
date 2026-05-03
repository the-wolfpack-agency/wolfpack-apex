/**
 * automations / dedup — canonical dedup-key computation for inbound
 * artifacts.
 *
 * WHY this exists: the pre-2026-05 contract used (source_message_id,
 * content_sha256) where source_message_id was the Microsoft Graph
 * mailbox-scoped resource id. That id is NOT the same value across
 * mailboxes, survives a mailbox migration (ids get re-issued), and
 * isn't even present for direct uploads. The result was a steady
 * stream of false-positive duplicate flags AND occasional duplicate
 * ingests of the same RFC-5322 message arriving in two mailboxes.
 *
 * The new contract:
 *
 *   PRIMARY:   internet_message_id  (RFC 5322 Message-Id header,
 *              globally unique per message, stable across mailboxes,
 *              survives Graph index rebuilds).
 *   SECONDARY: SHA-256 over a normalized tuple of (subject, from,
 *              received_iso, body_first_512_bytes). Used only when
 *              internet_message_id is missing — the body slice
 *              distinguishes weekly reports that share subject + sender
 *              but contain genuinely-different rosters.
 *
 * The output is a single TEXT column (artifacts.dedup_key) prefixed so
 * the storage shape is debuggable from a SQL prompt:
 *
 *   "imid:<lowercased-trimmed-internet-message-id>"
 *   "fb:<sha256-hex>"           (fallback, computed below)
 *
 * Pure helpers — no I/O, no DB. Server- and client-safe.
 */

import { createHash } from "node:crypto";

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

export interface DedupInput {
  /** RFC 5322 Message-Id (with or without angle brackets). null when
   *  Graph didn't return the header (rare) or the artifact is a direct
   *  upload. */
  internet_message_id: string | null | undefined;
  /** Subject line, trimmed but case preserved. */
  subject: string | null | undefined;
  /** Sender email address. */
  from: string | null | undefined;
  /** ISO 8601 receivedDateTime from Graph. Used at second-precision so
   *  the same message re-fetched in the same poll always hashes to the
   *  same value. */
  received_iso: string | null | undefined;
  /** Raw bytes — used to derive a body-first-512 chunk when no
   *  internet_message_id is available. For .eml ingests this is the
   *  RFC822 buffer; for xlsx attachments this is the spreadsheet body. */
  bytes: Buffer | null | undefined;
}

export interface DedupKey {
  /** The canonical key written to artifacts.dedup_key. */
  dedup_key: string;
  /** The internet_message_id stored alongside (lowercased + bracket-
   *  stripped). null when not available. Mirrored to its own column so
   *  diagnostic queries don't have to parse the prefixed dedup_key. */
  internet_message_id: string | null;
  /** Which strategy produced the key — useful for analytics + tests. */
  strategy: "internet_message_id" | "fallback_hash";
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Normalize an RFC 5322 Message-Id: strip angle brackets, lowercase,
 *  trim. Microsoft sometimes returns `<id@host>` and sometimes `id@host`;
 *  callers should not have to know the difference. */
export function normalizeInternetMessageId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const stripped = trimmed.replace(/^<+/, "").replace(/>+$/, "").trim();
  if (!stripped) return null;
  return stripped.toLowerCase();
}

/* ------------------------------------------------------------------ */
/* Canonical dedup-key                                                 */
/* ------------------------------------------------------------------ */

/**
 * Compute the canonical dedup_key for an artifact. ALWAYS returns a
 * non-empty string — callers can persist the result directly.
 *
 * Idempotent: identical input produces identical output. A re-poll of
 * the same Graph message (same RFC822 Message-Id) will collapse to the
 * same key even when Graph mutates the mailbox-scoped `id`.
 */
export function computeDedupKey(input: DedupInput): DedupKey {
  const imid = normalizeInternetMessageId(input.internet_message_id);
  if (imid) {
    return {
      dedup_key: `imid:${imid}`,
      internet_message_id: imid,
      strategy: "internet_message_id",
    };
  }

  // Fallback: SHA-256 over (subject || '') + '|' + (from || '') +
  // '|' + (received_iso || '') + '|' + body_first_512_bytes.
  // Body chunk distinguishes genuinely-different messages with the
  // same subject + sender (e.g. "Daily Class Report" delivered every
  // weekday).
  const subject = (input.subject ?? "").trim();
  const from = (input.from ?? "").trim().toLowerCase();
  const receivedIso = (input.received_iso ?? "").trim();
  const bodyChunk = (input.bytes ?? Buffer.alloc(0)).slice(0, 512);

  const hasher = createHash("sha256");
  hasher.update(subject);
  hasher.update("|");
  hasher.update(from);
  hasher.update("|");
  hasher.update(receivedIso);
  hasher.update("|");
  hasher.update(bodyChunk);
  const hex = hasher.digest("hex");

  return {
    dedup_key: `fb:${hex}`,
    internet_message_id: null,
    strategy: "fallback_hash",
  };
}
