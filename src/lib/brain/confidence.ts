/**
 * Whether a question carries enough to be answered by quoting a document.
 *
 * WHY A SCORE IS NOT ENOUGH
 *
 * The brain gate quoted any keyword hit scoring 0.05 or better on ts_rank_cd.
 * Measured against the real production index on 2026-08-24:
 *
 *   0.5000  "yes"
 *   0.4000  "ok do that"
 *   0.3000  "thanks"
 *   0.1051  "check the numbers"
 *   0.1045  "who is on the leadership team"
 *   0.0510  "start my day"
 *   0.0404  "what is the policy on time off"
 *
 * The three highest scores in the sample are the three messages that are not
 * questions at all, and a real question about time-off policy scores below the
 * floor. There is no threshold that separates those columns, because ts_rank_cd
 * is not comparable across queries of different lengths: a one-word query
 * matching a short chunk ranks enormously.
 *
 * This is what let "start my day" come back with a chunk of a Porsche mobile
 * coaching spreadsheet, reported 2026-08-24.
 *
 * WHAT DOES SEPARATE THEM
 *
 * How much the person actually said. "yes" and "thanks" carry nothing to be
 * about. A quoted document is a confident, specific claim, so it needs a
 * question specific enough to be wrong about.
 *
 * This is deliberately NOT applied to semantic hits. An embedding match is
 * evidence of aboutness, which is the thing being approximated here.
 */

/** Words that carry no subject. Kept short on purpose: a long list starts
 *  removing the actual question. */
const EMPTY_WORDS = new Set([
  "a", "about", "all", "am", "an", "and", "any", "are", "as", "at", "be", "been",
  "but", "by", "can", "could", "did", "do", "does", "for", "from", "get", "give",
  "had", "has", "have", "he", "her", "here", "hi", "him", "his", "how", "i", "if",
  "in", "is", "it", "its", "just", "know", "me", "my", "no", "not", "now", "of",
  "ok", "okay", "on", "one", "or", "our", "out", "please", "she", "should", "so",
  "some", "tell", "than", "thanks", "that", "the", "their", "them", "then",
  "there", "these", "they", "this", "to", "up", "us", "was", "we", "well",
  "were", "what", "when", "where", "which", "who", "why", "will", "with",
  "would", "yes", "yep", "you", "your", "yeah", "sure", "hey", "hello",
]);

/** At least this many distinct subject words before a document is quoted. */
export const MIN_SUBJECT_WORDS = 2;

/** The words in a message that carry a subject. */
export function subjectWords(message: string): string[] {
  const seen = new Set<string>();
  for (const raw of (message ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    if (EMPTY_WORDS.has(raw)) continue;
    seen.add(raw);
  }
  return [...seen];
}

/**
 * True when a keyword-only match may be quoted back as an answer.
 *
 * A false here is not "no answer". The hits still ground the model, which can
 * use them or say it does not know. What it may not do is present a document
 * as the answer to a message that was not asking anything.
 */
export function carriesEnoughToQuote(message: string): boolean {
  return subjectWords(message).length >= MIN_SUBJECT_WORDS;
}
