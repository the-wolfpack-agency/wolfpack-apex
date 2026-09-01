/**
 * What makes an eval pair worth grading, as rules a test can check.
 *
 * These lived inside the generator script, where nothing could exercise them.
 * That matters more than usual: each rule exists because a specific bad pair
 * got through, and a rule nobody runs is indistinguishable from one that
 * works. One of them reported catching nothing on a run where nothing happened
 * to collide, which reads exactly like a rule that is broken.
 *
 * A pair is worth grading when a person could ask the question, one document
 * answers it, and no OTHER document answers it equally well. Every rule below
 * is one of the three ways that fails.
 */

/**
 * Does the question just restate the filename?
 *
 * The failure this exists for: the old harvester's most-cited candidate was
 * the question "Meeting Notes with McDonalds" expecting the file "Meeting
 * Notes with McDonalds", on 52 citations. Retrieval cannot fail it, so it
 * measures nothing and raises every score it appears in.
 */
export function namesTheFile(question: string, filename: string): boolean {
  const q = distinctive(question);
  const f = [...distinctive(filename)];
  if (f.length === 0) return false;
  return f.filter((w) => q.has(w)).length / f.length >= 0.5;
}

/**
 * The part of a filename that identifies a FAMILY rather than a member.
 *
 * The corpus holds ten cohort survey exports with the same columns and the
 * same questions, differing by hotel and week. Any of them answers "how
 * effective were the pre-event communications", so a pair naming one marks
 * retrieval wrong for finding another that is equally right, and the eval
 * reports a failure that is really a tie.
 *
 * ONLY DATES ARE STRIPPED. Stripping every number was the first attempt and it
 * was wrong: it made "BA101 Day 1" and "BA101 Day 2" siblings, when a course's
 * first and third days are different content with different answers. It threw
 * out 30 of 46 documents to catch 10 real duplicates. A number usually
 * distinguishes a document; a date distinguishes a re-run of one.
 */
export function familyStem(filename: string): string {
  return filename
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/\d{1,2}[._/-]\d{1,2}([._/-]\d{2,4})?/g, " ")
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 3)
    .join(" ");
}

/**
 * How alike two questions are, ignoring the words every question shares.
 *
 * Catches the ambiguity that survives the family check: a shared activity
 * described in two unrelated documents. Both courses close with participants
 * writing themselves a congratulatory note, so two guides produced nearly the
 * same question, each naming a different file as the only right answer.
 * Whichever the retriever finds, one of those pairs marks it wrong.
 */
export function questionOverlap(a: string, b: string): number {
  const x = distinctive(a);
  const y = distinctive(b);
  const smaller = x.size <= y.size ? x : y;
  const larger = x.size <= y.size ? y : x;
  if (smaller.size === 0) return 0;
  return [...smaller].filter((w) => larger.has(w)).length / smaller.size;
}

/** Two questions this alike are about the same thing. */
export const COLLISION = 0.6;

/**
 * Kept deliberately short.
 *
 * Over-listing makes every question overlap with every other, and the
 * collision rule then drops the whole set while looking like it is working.
 */
const STOPWORDS = new Set([
  "what", "which", "does", "this", "that", "with", "from", "have", "about",
  "their", "there", "when", "where", "should", "would", "could", "involves",
]);

function distinctive(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/, "")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w)),
  );
}

/** Indexes of pairs that are ambiguous against another pair. Both go. */
export function collidingPairs(
  pairs: readonly { question: string; expectFilename: string }[],
): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      if (pairs[i].expectFilename === pairs[j].expectFilename) continue;
      if (questionOverlap(pairs[i].question, pairs[j].question) >= COLLISION) {
        out.add(i);
        out.add(j);
      }
    }
  }
  return out;
}
