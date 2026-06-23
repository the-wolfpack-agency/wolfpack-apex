/**
 * Pure, deterministic field-extraction helpers for the declarative agent
 * operation registry.
 *
 * An agent operation (registry.ts) declares its fields, and each field reuses
 * one of these tiny extractors to pull a value out of the natural-language
 * instruction the planner produced. Keeping the extractors here (small, pure,
 * zero-token, individually unit-tested) is what lets a NEW operation be a few
 * declarative lines: the operation only points each field at the right helper.
 *
 * Design:
 *   - Pure functions, no IO, no LLM. Fully deterministic + testable.
 *   - Each returns `string | undefined`. Undefined means "not present in this
 *     instruction"; a required field that resolves to undefined makes the
 *     executor escalate to the owner rather than submit an invalid action.
 *   - URL extraction normalizes a bare domain ("ogiam.com") into a full https
 *     URL so a downstream route that requires an absolute URL accepts it.
 */

/**
 * Find a target URL in the instruction.
 *
 * Two recognized shapes, in priority order:
 *   1. A literal http(s) URL anywhere in the text, e.g.
 *      "create a QR code for https://example.com/x".
 *   2. A bare domain after a linking preposition ("linked to"/"to"/"for"/
 *      "pointing to"/"that points to" X), e.g. "a QR code linked to ogiam.com".
 *      A bare domain is normalized to "https://<domain>".
 *
 * Returns a normalized absolute https(.s) URL, or undefined when none is found.
 * Never throws.
 */
export function extractUrl(instruction: string): string | undefined {
  const text = (instruction ?? "").trim();
  if (!text) return undefined;

  // (1) An explicit http(s) URL anywhere in the text wins.
  const explicit = /\bhttps?:\/\/[^\s"'<>]+/i.exec(text);
  if (explicit) {
    return stripTrailingPunctuation(explicit[0]);
  }

  // (2) A bare domain after a linking preposition. We require the preposition so
  // a random word that looks domain-ish (e.g. "e.g") is not mistaken for a URL.
  const linked =
    /\b(?:linked\s+to|pointing\s+to|points\s+to|point\s+to|linked|to|for)\s+["']?((?:https?:\/\/)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?:\/[^\s"'<>]*)?)["']?/i.exec(
      text,
    );
  if (linked) {
    const raw = stripTrailingPunctuation(linked[1]);
    if (/^https?:\/\//i.test(raw)) return raw;
    // Bare domain: normalize to an absolute https URL.
    return `https://${raw}`;
  }

  return undefined;
}

/**
 * Extract a label from a "titled/called/named X" clause. The label runs to a
 * connective ("that"/"which"/"linked"/"pointing"/"to"/"for") or end-of-string,
 * so "titled AGENT1 that is linked to ogiam.com" yields "AGENT1", not the whole
 * tail. Returns the trimmed label, or undefined when no clause is present.
 * Never throws.
 */
export function extractLabel(instruction: string): string | undefined {
  const text = (instruction ?? "").trim();
  if (!text) return undefined;

  const m =
    /\b(?:titled|called|named|labell?ed)\s+["']?(.+?)["']?(?:\s+(?:that|which|linked|pointing|points|point|to|for)\b|["']|\s*$)/i.exec(
      text,
    );
  if (!m) return undefined;
  const label = m[1].trim();
  return label.length > 0 ? label : undefined;
}

/**
 * Trim trailing sentence punctuation that a URL/domain match may have greedily
 * swallowed (a period, comma, paren, quote). A trailing slash is meaningful in a
 * path and is kept.
 */
function stripTrailingPunctuation(s: string): string {
  return s.replace(/["'.,;:)\]}>]+$/g, "");
}
