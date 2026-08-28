/**
 * An answer that says this product cannot do something it can.
 *
 * THE INCIDENT. Read back from the deployed assistant on 2026-08-28, in one
 * sitting, with no prompting to make it look bad:
 *
 *   "what files can you see"        -> "I don't have direct access to your file
 *                                       system or repository. To assist you,
 *                                       you can share file paths, filenames, or
 *                                       relevant code snippets."
 *   "can you send an email for me"  -> "I cannot send emails directly."
 *   "how many open tasks do I have" -> "I cannot check your open tasks."
 *
 * Every one is false. The product reads seventeen Microsoft Graph surfaces, a
 * Brain full of the client's own SharePoint, holds Mail.Send behind a compose
 * form, and answered "what should I work on today" from the tasks tool two
 * prompts before it claimed it could not check tasks.
 *
 * WHY IT GOT WORSE INSTEAD OF BETTER. Two of those three came back from
 * knowledge_cache and one from user_qa_cache. The model produced them once,
 * months ago, under a system prompt that told it it was a coding assistant for
 * a different product, and the learning loop SAVED THEM AS FACTS. They are now
 * served instantly, at zero tokens, with none of the checks that might have
 * caught them, and they will be served forever. The system built to get better
 * with use had been getting more confidently wrong with use.
 *
 * The existing gate already refused clarifying answers ("did you mean", "could
 * you clarify") for exactly this reason after a typo poisoned every "insights"
 * query in May. It never considered that the model might refuse its own
 * product, so this whole class walked straight through it.
 *
 * ONE PREDICATE, THREE PLACES. Reused, never re-implemented:
 *   - saveAnswer refuses to write one (stops new poison)
 *   - the conversation cache refuses to replay one (stops old poison, without
 *     deleting anybody's conversation history)
 *   - a migration removes the ones already stored
 * Three copies of a regex list would drift within a month, and the third copy
 * is SQL, which is where it would drift silently.
 *
 * WHAT IT MUST NOT CATCH. "Financials are not connected yet, connect QuickBooks
 * in Admin, Connectors" is the answer we WANT: it names a missing connection
 * and where to fix it. Every pattern here is anchored on a first-person subject
 * followed by an inability, so a document that says employees cannot access the
 * building after hours is untouched, and so is every honest not-connected-yet.
 *
 * WHAT IT CATCHES BEYOND CAPABILITY DENIALS, on purpose. Run against the 222
 * stored answers in production it matched 16, and three of those are CORRECT
 * refusals rather than false claims: a prompt-injection attempt turned away, an
 * SSN it declined to verify, a national insurance number it declined to store.
 * Those are the product behaving well, and they are still not cacheable. A
 * stored refusal is keyed by question and served by fuzzy match, so keeping one
 * lets a later, innocent question inherit a refusal it never earned. Both
 * classes leave the cache. Only one of them was a lie.
 *
 * A further row was the answer-reviewer's own critique ("The draft answer
 * misinterprets the question...") stored as though it were the answer. That is
 * a separate leak and not what this file is for, but it is poison by the same
 * definition and it goes with the rest.
 */

/**
 * First-person inability, in the shapes the model actually produces.
 *
 * Anchored on "I" so third-party prose is never matched. Kept narrow on the
 * verb: a denial about a capability, not every sentence containing "cannot".
 */
export const CAPABILITY_DENIAL_PATTERNS: readonly RegExp[] = [
  /\bI\s+(?:can\s?not|cannot|can'?t)\s+(?:directly\s+)?(?:send|access|check|read|see|open|retrieve|search|look\s+up|view|find|fetch|browse|list|determine)\b/i,
  /\bI\s+(?:do\s+not|don'?t)\s+have\s+(?:direct\s+)?access\s+to\b/i,
  /\bI\s+(?:do\s+not|don'?t)\s+have\s+the\s+ability\s+to\b/i,
  /\bI\s+(?:am|'m)\s+(?:not\s+able|unable)\s+to\s+(?:send|access|check|read|see|open|retrieve|view|find|fetch|browse|list)\b/i,
  /\bI\s+(?:do\s+not|don'?t)\s+have\s+access\s+to\s+(?:information|data|your)\b/i,
  /\bas\s+an\s+AI\b/i,
  /* THE TELL THAT GIVES THE WHOLE THING AWAY. Asking the reader to paste file
     contents or code is a coding assistant talking to a developer. Nobody
     using this product should ever be asked to hand it a file path: it holds
     their files. */
  /\bshare\s+(?:the\s+)?(?:file\s+paths?|filenames?|code\s+snippets?)\b/i,
];

/** True when the answer denies a capability this product has. */
export function deniesCapability(answer: string): boolean {
  if (!answer) return false;
  return CAPABILITY_DENIAL_PATTERNS.some((re) => re.test(answer));
}

/**
 * The same rule as SQL, for the cache read and the cleanup migration.
 *
 * ILIKE rather than a regex operator on purpose: the patterns above use
 * alternation and word boundaries that Postgres spells differently, and a
 * hand-translated regex is precisely the drift this file exists to stop. These
 * are the literal substrings each pattern is built around, which is a slightly
 * wider net in SQL than in TypeScript. Wider is the safe direction: the cost of
 * a false positive is one answer recomputed, and the cost of a false negative
 * is a client being told the product cannot do what they bought it for.
 *
 * THE COLUMN IS VALIDATED, NOT TRUSTED. This builds a SQL fragment, so a caller
 * that ever passed reader input as `col` would have written an injection. The
 * repo's SQL ratchet flags every interpolation into a query literal and asks
 * for proof the value cannot be attacker text; an allowlist entry asserting
 * "the callers all pass constants today" is a promise about callers that do not
 * exist yet. Rejecting anything that is not a plain identifier makes the proof
 * structural: there is no string a caller can pass that reaches the query and
 * is not `word` or `word.word`.
 *
 * @param col  Column reference, already qualified by the caller.
 * @throws     When `col` is not a bare or table-qualified identifier.
 */
export function capabilityDenialSql(col: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(col)) {
    throw new Error(
      `capabilityDenialSql: refusing to build SQL around ${JSON.stringify(col)}; expected a column identifier`,
    );
  }
  const fragments = [
    "%I cannot %",
    "%I can not %",
    "%I can't %",
    "%I do not have direct access%",
    "%I don't have direct access%",
    "%I do not have access to%",
    "%I don't have access to%",
    "%I do not have the ability%",
    "%I don't have the ability%",
    "%I am unable to%",
    "%I'm unable to%",
    "%I am not able to%",
    "%as an AI%",
    "%share file paths%",
    "%code snippets%",
  ];
  return fragments.map((f) => `${col} NOT ILIKE '${f.replace(/'/g, "''")}'`).join("\n            AND ");
}
