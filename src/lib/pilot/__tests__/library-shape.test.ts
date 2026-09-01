/**
 * Week-one questions, and why none of them is a conclusion.
 *
 * THE MISTAKE THIS AVOIDS, FROM OUR OWN CORPUS. 413 of 982 indexed documents
 * turned out to be output from our own scanning tools, and 5 documents hold
 * half the passages. Both look like findings about a library and neither is:
 * one is a pipeline artifact, the other a data export. A report that concluded
 * from either would have been confidently wrong about the client's library on
 * the first page it ever showed them.
 *
 * The calendar taught the same lesson from the other side. Meeting hours were
 * roughly ten times too large until somebody said "anyone whose meeting says
 * OOO is just a vacation day". No amount of reading the data produces that
 * sentence.
 */

import {
  libraryQuestions,
  findFamilies,
  concentration,
  FAMILY_THRESHOLD,
  FAMILY_SHARE_WORTH_ASKING,
  type LibraryDocument,
} from "@/lib/pilot/library-shape";

const doc = (filename: string, chunks = 1): LibraryDocument => ({ filename, chunks });
const many = (n: number, make: (i: number) => LibraryDocument) =>
  Array.from({ length: n }, (_, i) => make(i));

describe("what it notices", () => {
  /* THE REAL ONE. 42 per cent of the library was our own tooling writing into
     it, which nobody had spotted because every figure counted it as a
     document. */
  it("spots a naming pattern that covers a large share of the library", () => {
    const docs = [
      ...many(40, (i) => doc(`platform-scan-wolfpack-auto-src-${i}.txt`)),
      ...many(60, (i) => doc(`Client Agreement ${i}.pdf`)),
    ];
    const q = libraryQuestions(docs).find((x) => /naming pattern/.test(x.noticed));
    expect(q).toBeDefined();
    expect(q!.noticed).toMatch(/40 of 100/);
    expect(q!.noticed).toMatch(/40%/);
  });

  it("stays quiet about a family too small to mean anything", () => {
    const docs = [...many(2, (i) => doc(`Export ${i}.csv`)), ...many(98, (i) => doc(`Doc ${i}.pdf`))];
    expect(libraryQuestions(docs).find((x) => /naming pattern/.test(x.noticed))).toBeUndefined();
  });

  it("spots a handful of documents carrying half the text", () => {
    const docs = [...many(3, (i) => doc(`Huge Export ${i}.xlsx`, 500)), ...many(50, (i) => doc(`Note ${i}.md`, 2))];
    const q = libraryQuestions(docs).find((x) => /half the searchable text/.test(x.noticed));
    expect(q).toBeDefined();
    /* Two of the three exports already exceed half of 1,600 passages, so two
       is the honest count. Three would have been the answer to a different
       question. */
    expect(q!.noticed).toMatch(/2 of 53/);
  });

  /* A library where every document is the same size has no concentration to
     report, and saying "27 documents hold half the text" of 54 is noise. */
  it("stays quiet when the text is spread evenly", () => {
    const docs = many(60, (i) => doc(`Even ${i}.pdf`, 10));
    expect(libraryQuestions(docs).find((x) => /half the searchable/.test(x.noticed))).toBeUndefined();
  });

  it("orders by how much of the library each concerns", () => {
    /* The family name has to be in the first three words, because that is
       where familyStem looks. "platform-scan-0" and "platform-scan-1" are
       different stems: only dates are stripped, and a trailing number usually
       distinguishes a document rather than a re-run of one. */
    const docs = [
      ...many(40, (i) => doc(`platform-scan-wolfpack-auto-${i}.txt`, 1)),
      ...many(3, (i) => doc(`Big Export ${i}.xlsx`, 900)),
      ...many(57, (i) => doc(`Doc ${i}.pdf`, 1)),
    ];
    /* The first question is usually the only one that gets answered. */
    expect(libraryQuestions(docs)[0].noticed).toMatch(/naming pattern/);
  });
});

describe("what it refuses to do", () => {
  /* THE WHOLE DESIGN. A conclusion here would have told a client their library
     was 42 per cent one kind of document, when it was our tooling. */
  it("ends every finding in a question, never a verdict", () => {
    const docs = [
      ...many(40, (i) => doc(`platform-scan-${i}.txt`)),
      ...many(60, (i) => doc(`Doc ${i}.pdf`, 200)),
    ];
    for (const q of libraryQuestions(docs)) {
      expect(q.ask).toMatch(/\?$/);
      /* Nothing that reads as a decision already taken. */
      expect(q.noticed).not.toMatch(/\b(should|must|recommend|problem|wrong|bad)\b/i);
    }
  });

  it("shows filenames as examples and never contents", () => {
    const docs = many(10, (i) => doc(`Export ${i}.csv`, 5));
    for (const q of libraryQuestions(docs)) {
      expect(q.examples.length).toBeGreaterThan(0);
      expect(q.examples.length).toBeLessThanOrEqual(3);
      for (const e of q.examples) expect(docs.some((d) => d.filename === e)).toBe(true);
    }
  });

  it("says nothing at all about an empty library", () => {
    expect(libraryQuestions([])).toEqual([]);
  });
});

describe("the rules underneath", () => {
  it("groups re-runs of one export and keeps different documents apart", () => {
    const families = findFamilies([
      doc("Survey Data PCBA 101 Conrad_May 11-15.xlsx"),
      doc("Survey Data PCBA_WO 8.10-8.17_All.xlsx"),
      doc("BA101_Day 1_MLG.pdf"),
      doc("BA101_Day 3_MLG.pdf"),
    ]);
    const sizes = [...families.values()].map((v) => v.length).sort();
    /* The two surveys are one family; the two course days are not. */
    expect(sizes).toEqual([1, 1, 2]);
  });

  it("ignores documents with no text when asking about concentration", () => {
    const c = concentration([doc("empty.png", 0), doc("real.pdf", 10)]);
    expect(c.ofTotal).toBe(1);
  });

  it("keeps its thresholds visible", () => {
    expect(FAMILY_THRESHOLD).toBeGreaterThanOrEqual(3);
    expect(FAMILY_SHARE_WORTH_ASKING).toBeGreaterThan(0);
    expect(FAMILY_SHARE_WORTH_ASKING).toBeLessThan(0.5);
  });
});
