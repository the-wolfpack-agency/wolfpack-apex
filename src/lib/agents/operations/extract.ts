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
 * Extract the search QUERY from a web-search instruction. Backs the web_search
 * operation's `query` field.
 *
 * Recognized phrasings (the connective that introduces the query is dropped):
 *   - "search the web for X"            -> X
 *   - "scan the internet for X"         -> X
 *   - "look up X online"               -> X   (trailing "online" stripped)
 *   - "search for X" / "find news on X" -> X
 *   - "the latest news on X" / "news about X" -> the part after on/about
 *
 * Strategy (priority-ordered):
 *   1. A "for X" connective wins: everything after "for" is the query verbatim,
 *      keeping its own leading article ("scan the internet for the latest news
 *      on auto SAAS companies" -> "the latest news on auto SAAS companies").
 *   2. Else a "news on|about X" phrase -> the part after the connective.
 *   3. Else strip a leading verb-phrase + the web/internet/online surface noun
 *      (and a connective the verb left behind) -> the remaining query.
 *   A trailing " online" qualifier and surrounding quotes/punctuation are
 *   trimmed throughout.
 *
 * Returns the trimmed query, or undefined when nothing meaningful remains.
 * Pure, never throws.
 */
export function extractSearchQuery(instruction: string): string | undefined {
  let text = (instruction ?? "").trim();
  if (!text) return undefined;

  // Drop trailing sentence punctuation up front so "...companies." trims clean.
  text = text.replace(/[.?!;,]+$/g, "").trim();

  // Strip a trailing " online" qualifier first ("look up X online" -> "look up
  // X"), so it doesn't survive into the query tail.
  text = text.replace(/\s+online$/i, "").trim();

  let query: string | undefined;

  // (1) Highest priority: a "for ..." connective. Everything after "for" is the
  // query VERBATIM (keeping its own leading article), e.g.
  // "scan the internet for the latest news on auto SAAS companies" -> "the
  // latest news on auto SAAS companies".
  const forMatch = /\bfor\s+(.+)$/i.exec(text);
  if (forMatch) {
    query = forMatch[1];
  }

  // (2) A "news on|about X" / "(latest) news on X" phrase -> the part after the
  // connective. Handles "find news on X" and a bare "the latest news on X".
  if (query === undefined) {
    const newsMatch = /\bnews\s+(?:on|about|of|regarding)\s+(.+)$/i.exec(text);
    if (newsMatch) query = newsMatch[1];
  }

  // (3) Otherwise strip a leading search verb-phrase + optional article + the
  // web|internet|online surface noun + a trailing connective, leaving the query.
  if (query === undefined) {
    let rest = text;
    const verbPhrase =
      /^\s*(?:please\s+)?(?:search|scan|look\s*up|lookup|find|get|fetch|research|google)\b/i;
    const verbMatch = verbPhrase.exec(rest);
    if (verbMatch) {
      rest = rest.slice(verbMatch[0].length).trim();
      // Strip the surface noun ("web"/"internet"/"online") plus an article that
      // PRECEDES it ("search the web ..."), but keep an article that belongs to
      // the query itself ("look up THE GDP of France" -> "the GDP of France").
      rest = rest
        .replace(/^(?:the|a|an)\s+(?:web|internet|online|net)\b/i, "")
        .trim();
      rest = rest.replace(/^(?:web|internet|online|net)\b/i, "").trim();
    }
    // Drop a leading connective the verb left behind ("about"/"on"/"regarding").
    rest = rest.replace(/^(?:about|on|regarding|of)\s+/i, "").trim();
    query = rest;
  }

  if (query === undefined) return undefined;

  // Strip surrounding quotes + any residual trailing punctuation.
  query = query.replace(/^["']+|["']+$/g, "").trim();
  query = stripTrailingPunctuation(query);

  return query.length > 0 ? query : undefined;
}

/**
 * Trim trailing sentence punctuation that a URL/domain match may have greedily
 * swallowed (a period, comma, paren, quote). A trailing slash is meaningful in a
 * path and is kept.
 */
function stripTrailingPunctuation(s: string): string {
  return s.replace(/["'.,;:)\]}>]+$/g, "");
}
