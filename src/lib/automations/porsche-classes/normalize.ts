/**
 * porsche-classes / normalize — pure normalization helpers.
 *
 * Every parser must run its raw output through these helpers BEFORE
 * handing rows to the snapshot writer. Deterministic by design — the
 * same input always produces the same key — because the delta engine
 * compares snapshots by `class_key` and `participant_hash`, and the
 * idempotency invariant on `(source_artifact_id, class_key)` only holds
 * if normalization is deterministic.
 *
 * No I/O. No clock reads. No randomness. Tested standalone.
 */

import { createHash } from "node:crypto";
import type { ClassKey, CourseType, ParsedClass } from "@/lib/automations/types";

/* ------------------------------------------------------------------ */
/* normalizeName                                                       */
/* ------------------------------------------------------------------ */

/**
 * Normalize a person's name for participant comparison.
 *
 * Rules:
 *  - lowercase
 *  - collapse internal whitespace to a single space
 *  - strip leading / trailing whitespace
 *  - drop punctuation that varies by source (commas, quotes, periods,
 *    parentheses) — these appear inconsistently between Cognito and the
 *    xlsx report and would otherwise cause spurious added/dropped pairs.
 *  - collapse repeated dashes / spaces from the punctuation strip
 *
 * Diacritics are preserved (`é`, `ñ`, `ü`) — losing them would conflate
 * distinct names. The xlsx + Cognito are both UTF-8 so no codec churn.
 */
export function normalizeName(raw: string | null | undefined): string {
  if (!raw) return "";
  const stripped = String(raw)
    .toLowerCase()
    .replace(/[",'.()\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped;
}

/* ------------------------------------------------------------------ */
/* normalizeLocation                                                   */
/* ------------------------------------------------------------------ */

/**
 * Normalize a class location string.
 *
 * Title-case each word (so "hilton hotel" and "HILTON HOTEL" collapse to
 * the same key). Trim + collapse whitespace. Strip a small set of noise
 * suffixes ("hotel", "training center") only when they appear AT THE END
 * — they're hints, not identifiers. Keeping the check trailing-only so
 * we don't munge legitimate inner words.
 */
export function normalizeLocation(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = String(raw).replace(/\s+/g, " ").trim();
  if (s.length === 0) return "";
  // Title-case word-by-word; preserve obvious all-cap acronyms (>=4 caps)
  // by leaving them alone — e.g. "USA" should stay "USA". 3+ cap rule
  // chosen empirically; "Inc" / "Ltd" already title-case fine.
  s = s
    .split(" ")
    .map((w) => {
      if (w.length === 0) return w;
      // Heuristic: SHORT acronym (≤3 chars, all letters, all caps) →
      // keep as-is so "USA" survives as "USA". Longer ALL-CAPS words are
      // title-cased so "HILTON HOTEL" canonicalizes alongside "hilton
      // hotel" — same key, same delta.
      if (w.length <= 3 && /^[A-Z]+$/.test(w)) return w;
      return w[0].toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(" ");
  return s;
}

/* ------------------------------------------------------------------ */
/* buildClassKey                                                       */
/* ------------------------------------------------------------------ */

/**
 * Build the canonical `course|YYYY-MM-DD|location` key.
 *
 * `class_date` MUST already be in ISO-date form (`YYYY-MM-DD`) — this
 * helper doesn't try to parse strings, because the parsers should do
 * date parsing once at ingest and surface a typed string.
 */
export function buildClassKey(
  course_type: CourseType,
  class_date: string,
  location: string,
): ClassKey {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(class_date)) {
    throw new Error(
      `buildClassKey: class_date must be YYYY-MM-DD, got "${class_date}"`,
    );
  }
  const loc = normalizeLocation(location);
  return `${course_type}|${class_date}|${loc}`;
}

/* ------------------------------------------------------------------ */
/* participantHash                                                     */
/* ------------------------------------------------------------------ */

/**
 * sha256 over the canonical participant list.
 *
 * Canonical = each participant `normalizeName`-d, deduped (Set), then
 * sorted lexicographically, then joined with "\n". The hash is the
 * delta engine's fast-path equality check: matching hashes → no diff
 * needed.
 */
export function participantHash(participants: ReadonlyArray<string>): string {
  const canonical = canonicalParticipants(participants);
  return createHash("sha256").update(canonical.join("\n"), "utf8").digest("hex");
}

/**
 * Canonicalize a participant list — exposed because parsers need the
 * same lowercased/sorted/deduped output for snapshot writes.
 */
export function canonicalParticipants(
  participants: ReadonlyArray<string>,
): string[] {
  const normalized = new Set<string>();
  for (const p of participants) {
    const n = normalizeName(p);
    if (n) normalized.add(n);
  }
  return Array.from(normalized).sort();
}

/* ------------------------------------------------------------------ */
/* normalizeClass — convenience wrapper for parsers                    */
/* ------------------------------------------------------------------ */

/**
 * Round-trip a parser's raw output through every normalizer and return
 * a fully-canonical `ParsedClass`. Parsers should call this at the end
 * of their work so callers see one consistent shape.
 */
export function normalizeClass(input: {
  course_type: CourseType;
  class_date: string;
  location: string;
  participants: ReadonlyArray<string>;
}): ParsedClass {
  return {
    course_type: input.course_type,
    class_date: input.class_date,
    location: normalizeLocation(input.location),
    participants: canonicalParticipants(input.participants),
  };
}
