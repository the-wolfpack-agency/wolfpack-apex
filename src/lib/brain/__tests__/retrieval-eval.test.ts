/**
 * Grade retrieval against known-correct answers, so ranking changes stop being
 * arguments.
 *
 * Retrieval changed three times in one day: filenames made searchable, then
 * weighted against semantic scores, and before that a relevance judge's input
 * window widened. Each was justified by ONE example and validated by re-running
 * that same example. That is anecdote with a deployment behind it.
 *
 * The specific smell is FILENAME_MATCH_WEIGHT = 9. Nothing says whether 6 or 12
 * would serve real questions better. The standard fix for two incomparable
 * score scales is Reciprocal Rank Fusion, and adopting it means changing
 * ranking for every question in the corpus with no way to tell if that helps.
 * This is that way.
 */
import {
  gradeRetrieval,
  isBetter,
  describeEval,
  type LabelledPair,
  type RankedResult,
} from "@/lib/brain/retrieval-eval";

const PAIRS: LabelledPair[] = [
  { question: "what are the payment terms?", expectFilename: "work order" },
  { question: "what is the refund window?", expectFilename: "services agreement" },
];

const results = (...names: string[]): RankedResult[] => names.map((filename) => ({ filename }));

describe("grading where the right document landed", () => {
  it("scores a perfect run", () => {
    const r = gradeRetrieval(PAIRS, (q) =>
      q.includes("payment")
        ? results("Acme Work Order 2026.pdf", "other.pdf")
        : results("Master Services Agreement.pdf", "other.pdf"),
    );
    expect(r.recall).toBe(1);
    expect(r.precisionAtOne).toBe(1);
    expect(r.mrr).toBe(1);
    expect(r.misses).toEqual([]);
  });

  /* THE MEASURE THAT MATTERS FOR RANKING. Recall cannot see the difference
     between the answer at position 1 and position 5, and that difference is
     the entire experience of using the product. */
  it("distinguishes found-at-1 from found-at-5, which recall cannot", () => {
    const atOne = gradeRetrieval([PAIRS[0]!], () => results("Acme Work Order.pdf", "a", "b"));
    const atFive = gradeRetrieval([PAIRS[0]!], () =>
      results("a", "b", "c", "d", "Acme Work Order.pdf"),
    );
    expect(atOne.recall).toBe(atFive.recall);
    expect(atOne.mrr).toBeGreaterThan(atFive.mrr);
    expect(atFive.mrr).toBeCloseTo(0.2, 5);
  });

  it("records a miss with the question, so there is something to work on", () => {
    const r = gradeRetrieval([PAIRS[0]!], () => results("unrelated.pdf"));
    expect(r.recall).toBe(0);
    expect(r.misses).toHaveLength(1);
    expect(r.misses[0]!.question).toBe("what are the payment terms?");
  });

  /* Real filenames carry timestamps and duplicate counters that change on a
     re-sync. An eval set that breaks on a re-upload gets deleted, not fixed. */
  it("matches a fragment through the separators filenames actually use", () => {
    const r = gradeRetrieval([{ question: "q", expectFilename: "work order" }], () =>
      results("viaPeople_Work-Order_Wolfpack Agency_5-7-25[36].docx.pdf"),
    );
    expect(r.recall).toBe(1);
  });
});

describe("deciding whether a ranking change helped", () => {
  const before = gradeRetrieval([PAIRS[0]!], () => results("a", "b", "Acme Work Order.pdf"));
  const after = gradeRetrieval([PAIRS[0]!], () => results("Acme Work Order.pdf", "a", "b"));

  it("prefers the ranking that puts the answer higher", () => {
    expect(isBetter(before, after)).toBe(true);
  });

  /* TIES GO TO THE INCUMBENT. A change that cannot show an improvement is
     churn, and churn in ranking is how a corpus gets quietly worse one
     defensible step at a time. */
  it("refuses a change that only ties", () => {
    expect(isBetter(after, after)).toBe(false);
  });

  it("refuses a change that makes it worse", () => {
    expect(isBetter(after, before)).toBe(false);
  });
});

describe("an empty eval set", () => {
  /* Scores zero, not a hundred percent. A suite with no cases passing
     everything is how a ranking change ships unmeasured. */
  it("does not report success", () => {
    const r = gradeRetrieval([], () => results("anything.pdf"));
    expect(r.mrr).toBe(0);
    expect(r.recall).toBe(0);
    expect(isBetter(r, r)).toBe(false);
  });
});

describe("the summary line", () => {
  it("carries the three numbers a reviewer needs", () => {
    const line = describeEval(gradeRetrieval(PAIRS, () => results("nope.pdf")));
    expect(line).toMatch(/labelled questions/);
    expect(line).toMatch(/MRR/);
    expect(line).toMatch(/never found/);
  });
});
