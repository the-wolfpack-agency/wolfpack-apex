/**
 * What is odd about this library, put as questions rather than conclusions.
 *
 * WHY QUESTIONS. The most expensive mistake available in week one is reading a
 * client's data and telling them what it means. Our own corpus makes the point:
 * 413 of 982 indexed documents turned out to be output from our own scanning
 * tools, and 5 documents hold half the passages. Both look like findings and
 * neither is: one is a pipeline artifact and the other is a data export. A
 * report that concluded from either would have been confidently wrong about
 * the client's library on the first page it ever showed them.
 *
 * The same lesson arrived from the other direction on the calendar: meeting
 * hours were roughly ten times too large until somebody said "anyone whose
 * meeting says OOO is just a vacation day". No amount of reading the data
 * produces that sentence. It has to be asked.
 *
 * SO EVERY FINDING HERE ENDS IN A QUESTION SOMEBODY CAN ANSWER IN ONE LINE,
 * and none of them ends in a number we intend to quote later.
 *
 * IT RUNS ON WHAT WEEK-ONE INGEST ALREADY PRODUCES. No new integration, no
 * extra permission, no model call. That matters because the point is to have
 * something specific to say about THEIR data at the first meeting, not after a
 * month of connecting things.
 */

import { familyStem } from "@/lib/brain/eval/pair-quality";

export interface LibraryDocument {
  filename: string;
  chunks: number;
}

export interface Observation {
  /** What was noticed, in one sentence, with the figure in it. */
  noticed: string;
  /** The question only somebody who knows this library can answer. */
  ask: string;
  /** Examples, so the question is concrete. Filenames, never contents. */
  examples: string[];
}

/**
 * A family this size is a pattern rather than a coincidence.
 *
 * Two files with similar names happen constantly. Three is a convention, an
 * export schedule, or a tool writing into the library.
 */
export const FAMILY_THRESHOLD = 3;

/** Below this share of the library a family is not worth a question. */
export const FAMILY_SHARE_WORTH_ASKING = 0.05;

/** The share of passages whose concentration is worth asking about. */
export const DOMINANCE_SHARE = 0.5;

/**
 * Groups of documents whose names say they are versions of one thing.
 *
 * Reuses the family rule written for the eval set rather than a second copy,
 * because the two would drift and this is the same judgment: names that differ
 * only by a date are re-runs, names that differ by a number are usually not.
 */
export function findFamilies(docs: readonly LibraryDocument[]): Map<string, string[]> {
  const families = new Map<string, string[]>();
  for (const d of docs) {
    const stem = familyStem(d.filename);
    if (!stem) continue;
    const existing = families.get(stem);
    if (existing) existing.push(d.filename);
    else families.set(stem, [d.filename]);
  }
  return families;
}

/**
 * How few documents carry half the searchable text.
 *
 * A library where five files hold half the passages behaves nothing like one
 * where five hundred do, and the difference decides whether retrieval is about
 * finding the right document or the right part of one.
 */
export function concentration(docs: readonly LibraryDocument[]): {
  documents: number;
  ofTotal: number;
  largest: LibraryDocument[];
} {
  const withText = docs.filter((d) => d.chunks > 0).sort((a, b) => b.chunks - a.chunks);
  const total = withText.reduce((s, d) => s + d.chunks, 0);
  if (total === 0) return { documents: 0, ofTotal: withText.length, largest: [] };

  let running = 0;
  let count = 0;
  for (const d of withText) {
    running += d.chunks;
    count += 1;
    if (running / total >= DOMINANCE_SHARE) break;
  }
  return { documents: count, ofTotal: withText.length, largest: withText.slice(0, 3) };
}

/**
 * The questions worth putting to somebody in week one.
 *
 * Ordered by how much of the library each concerns, because the first one is
 * usually the only one that gets answered.
 */
export function libraryQuestions(docs: readonly LibraryDocument[]): Observation[] {
  if (docs.length === 0) return [];
  const out: Observation[] = [];

  const families = [...findFamilies(docs).entries()]
    .filter(([, members]) => members.length >= FAMILY_THRESHOLD)
    .sort((a, b) => b[1].length - a[1].length);

  for (const [, members] of families) {
    const share = members.length / docs.length;
    if (share < FAMILY_SHARE_WORTH_ASKING) continue;
    out.push({
      noticed:
        `${members.length} of ${docs.length} documents share a naming pattern, ` +
        `which is ${Math.round(share * 100)}% of the library.`,
      ask:
        "Are these one thing that gets re-exported, output from a tool writing into this " +
        "library, or genuinely separate documents that happen to be named alike?",
      examples: members.slice(0, 3),
    });
  }

  const c = concentration(docs);
  if (c.documents > 0 && c.documents <= 10 && c.ofTotal > 20) {
    out.push({
      noticed:
        `${c.documents} of ${c.ofTotal} documents hold half the searchable text.`,
      ask:
        "Are these the documents people actually ask about, or large exports that happen to " +
        "carry a lot of rows? It changes whether search should be finding the right document " +
        "or the right part of one.",
      examples: c.largest.map((d) => d.filename),
    });
  }

  return out;
}
