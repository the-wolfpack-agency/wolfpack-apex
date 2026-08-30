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
  judgeChange,
  MIN_PAIRS_FOR_A_VERDICT,
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

  /* MRR sees the improvement. Whether that improvement is DECIDABLE is a
     separate question, and on one pair it is not: this originally asserted
     isBetter() here and passed, which is the same one-pair confidence that
     shipped RRF. */
  it("scores the ranking that puts the answer higher above the one that does not", () => {
    expect(after.mrr).toBeGreaterThan(before.mrr);
  });

  it("still refuses to call it a win on a single pair", () => {
    expect(isBetter(before, after)).toBe(false);
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

/**
 * A small set must not be allowed to decide.
 *
 * RRF was adopted on six pairs (MRR 0.557 -> 0.700) and reversed on twelve
 * (0.544 vs 0.503). The warning that six was too few was written BEFORE
 * adopting it, by the person who then adopted it. A rule somebody has to
 * remember is a rule that gets skipped by whoever is in a hurry, and that is
 * usually its author.
 */
describe("refusing to decide on too little evidence", () => {
  const pairs = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      question: `q${i}`,
      expectFilename: `doc${i}`,
    }));

  const runAt = (rank: number) => (q: string) => {
    const i = Number(q.slice(1));
    const out = Array.from({ length: 8 }, (_, j) => ({ filename: `filler${j}` }));
    out[rank - 1] = { filename: `doc${i}` };
    return out;
  };

  it("calls a clear improvement on a small set not-enough-evidence", () => {
    const small = pairs(MIN_PAIRS_FOR_A_VERDICT - 1);
    const before = gradeRetrieval(small, runAt(5));
    const after = gradeRetrieval(small, runAt(1));
    /* Genuinely better, and still refused. */
    expect(after.mrr).toBeGreaterThan(before.mrr);
    expect(judgeChange(before, after)).toBe("not_enough_evidence");
    expect(isBetter(before, after)).toBe(false);
  });

  it("decides once the set is big enough", () => {
    const big = pairs(MIN_PAIRS_FOR_A_VERDICT);
    expect(judgeChange(gradeRetrieval(big, runAt(5)), gradeRetrieval(big, runAt(1)))).toBe("better");
  });

  it("names a regression rather than merely refusing it", () => {
    const big = pairs(MIN_PAIRS_FOR_A_VERDICT);
    expect(judgeChange(gradeRetrieval(big, runAt(1)), gradeRetrieval(big, runAt(5)))).toBe("worse");
  });

  it("calls an identical result no_change, not better", () => {
    const big = pairs(MIN_PAIRS_FOR_A_VERDICT);
    const r = gradeRetrieval(big, runAt(2));
    expect(judgeChange(r, r)).toBe("no_change");
    expect(isBetter(r, r)).toBe(false);
  });

  /* The smaller of the two sets governs: comparing twelve against six is a
     comparison against six. */
  it("uses the smaller set when the two differ", () => {
    const big = gradeRetrieval(pairs(MIN_PAIRS_FOR_A_VERDICT), runAt(1));
    const small = gradeRetrieval(pairs(3), runAt(5));
    expect(judgeChange(small, big)).toBe("not_enough_evidence");
  });
});

/**
 * A QUESTION WITH SEVERAL RIGHT ANSWERS NEEDS A RULER THAT KNOWS IT.
 *
 * Found on 2026-08-30. "Which hotels were surveyed in August" was labelled
 * with one filename and scored as NEVER FOUND, while the corpus holds five
 * August surveys: Conrad Aug 10-14, Conrad Aug 17-21, Intercontinental Aug
 * 10-14, Ritz Carlton Las Colinas Aug 17-21, and WO 8.10-8.17_All.
 *
 * Retrieval was returning a correct document and being marked wrong for it.
 * That is worse than having no eval, because it sends somebody optimising a
 * system that already works: a tabular-chunking change was nearly built to
 * fix a measurement error.
 */
describe("a question with several correct answers", () => {
  const pair = {
    question: "which hotels were surveyed in August",
    expectFilename: "WO 8.10-8.17",
    alsoAccept: ["Conrad Aug 10-14", "Conrad Aug 17-21", "Intercontinental Aug 10-14", "Ritz Carlton Las Colinas Aug 17-21"],
  };

  it("counts an alternative as found", () => {
    const r = gradeRetrieval([pair], () => [
      { filename: "Survey Data PCBA_101_Conrad Aug 17-21.xlsx" },
    ]);
    expect(r.outcomes[0].found).toBe(true);
    expect(r.outcomes[0].rank).toBe(1);
  });

  /* Whichever acceptable document arrives FIRST decides the rank: somebody
     asking is served by the first one, not by the one we happened to label. */
  it("ranks by the first acceptable document, not the labelled one", () => {
    const r = gradeRetrieval([pair], () => [
      { filename: "Survey Data PCBA_101_Conrad Aug 10-14.xlsx" },
      { filename: "Survey Data PCBA_WO 8.10-8.17_All.xlsx" },
    ]);
    expect(r.outcomes[0].rank).toBe(1);
  });

  it("still counts the originally labelled document", () => {
    const r = gradeRetrieval([pair], () => [
      { filename: "Survey Data PCBA_WO 8.10-8.17_All.xlsx" },
    ]);
    expect(r.outcomes[0].found).toBe(true);
  });

  /* And must not become a rubber stamp: a wrong document is still wrong. */
  it("does not accept an unrelated document", () => {
    const r = gradeRetrieval([pair], () => [{ filename: "viaPeople Work Order.pdf" }]);
    expect(r.outcomes[0].found).toBe(false);
  });

  /* A pair with no alternatives behaves exactly as it always did. */
  it("leaves a single-answer pair untouched", () => {
    const strict = { question: "what are the payment terms", expectFilename: "viaPeople" };
    expect(gradeRetrieval([strict], () => [{ filename: "Invoice.pdf" }]).outcomes[0].found).toBe(false);
    expect(gradeRetrieval([strict], () => [{ filename: "viaPeople Work Order.pdf" }]).outcomes[0].found).toBe(true);
  });
});
