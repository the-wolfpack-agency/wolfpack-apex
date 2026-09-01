/**
 * One loop, so the eval grades the path the product takes.
 *
 * The judge ran inside the assistant and the eval measured queryBrain, so the
 * eval graded a path the product does not take. That is how query expansion
 * shipped unproven: its trigger is a judge rejection, and the only harness that
 * could have tested it never called the judge. Two runs produced numbers
 * identical to the rank, and zero expansions.
 *
 * A measurement that grades a different path than the one that runs is worse
 * than no measurement, because it reports numbers with the authority of a test.
 */
import { retrieve } from "@/lib/brain/retrieve";

const mockQuery = jest.fn();
jest.mock("@/lib/brain/query", () => ({
  queryBrain: (...a: unknown[]) => mockQuery(...a),
}));
jest.mock("@/lib/brain/qdrant", () => ({ SEMANTIC_SCORE_FLOOR: 0.36 }));

/* Hits are SEMANTIC by default because these tests exercise the score path,
   and the score path only applies to the scale the floor is about. A keyword
   hit under the floor is not a weak result, it is a different measurement. */
const execution = (hits: Array<{ score: number; source?: string }>) => ({
  query: "q",
  hits: hits.map((h, i) => ({
    source: "semantic",
    ...h,
    chunk_id: `c${i}`,
    content: "x",
    document_filename: "f",
  })),
  keyword_hits: 0,
  semantic_hits: 0,
  latency_ms: 1,
  tokens_used: 0,
  query_log_id: 0,
  semantic_status: "ok",
});

beforeEach(() => jest.clearAllMocks());

describe("without a judge or an expander", () => {
  it("is plain retrieval, and costs nothing extra", async () => {
    mockQuery.mockResolvedValue(execution([{ score: 0.9 }]));
    const r = await retrieve({ userId: "u", userRole: "cto", query: "q" });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(r.expanded).toBe(false);
  });
});

describe("the judge decides whether to pay again", () => {
  /* THE TRIGGER THAT MATTERS. Four hits at 0.45 look fine to every number here
     and are the wrong documents. Only the judge can say so. */
  it("expands when the judge rejects a confident-looking result", async () => {
    mockQuery
      .mockResolvedValueOnce(execution([{ score: 0.45 }, { score: 0.44 }]))
      .mockResolvedValueOnce(execution([{ score: 0.8 }]));
    const r = await retrieve({
      userId: "u",
      userRole: "cto",
      query: "how much do we owe upfront?",
      judge: async () => "irrelevant",
      expand: async () => "deposit due on execution",
    });
    expect(r.firstWasRejected).toBe(true);
    expect(r.expanded).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("does not expand when the judge accepts", async () => {
    mockQuery.mockResolvedValue(execution([{ score: 0.45 }]));
    const r = await retrieve({
      userId: "u",
      userRole: "cto",
      query: "q",
      judge: async () => "relevant",
      expand: async () => "other words",
    });
    expect(r.expanded).toBe(false);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  /* A judge that throws must not cost the retrieval that already succeeded. */
  it("keeps the result when the judge fails", async () => {
    mockQuery.mockResolvedValue(execution([{ score: 0.9 }]));
    const r = await retrieve({
      userId: "u",
      userRole: "cto",
      query: "q",
      judge: async () => {
        throw new Error("judge down");
      },
    });
    expect(r.execution.hits).toHaveLength(1);
  });
});

describe("keeping the better of the two", () => {
  /* A rewrite is a guess about vocabulary, and a guess that retrieved worse
     must not replace a result that was merely thin. */
  it("discards a rewrite that retrieved worse", async () => {
    mockQuery
      .mockResolvedValueOnce(execution([{ score: 0.3 }, { score: 0.2 }]))
      .mockResolvedValueOnce(execution([]));
    const r = await retrieve({
      userId: "u",
      userRole: "cto",
      query: "q",
      judge: async () => "irrelevant",
      expand: async () => "worse words",
    });
    expect(r.expansionHelped).toBe(false);
    expect(r.execution.hits).toHaveLength(2);
  });

  /* The query log must record what the person actually typed. An eval
     harvested from rewritten questions would grade the product on its own
     paraphrases. */
  it("reports the original question even when the rewrite won", async () => {
    mockQuery
      .mockResolvedValueOnce(execution([]))
      .mockResolvedValueOnce(execution([{ score: 0.9 }]));
    const r = await retrieve({
      userId: "u",
      userRole: "cto",
      query: "the original",
      judge: async () => "irrelevant",
      expand: async () => "rewritten",
    });
    expect(r.expansionHelped).toBe(true);
    expect(r.execution.query).toBe("the original");
    expect(r.rewritten).toBe("rewritten");
  });

  it("does not retry when the rewrite changed nothing", async () => {
    mockQuery.mockResolvedValue(execution([]));
    const r = await retrieve({
      userId: "u",
      userRole: "cto",
      query: "same",
      expand: async () => "same",
    });
    expect(r.expanded).toBe(false);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

/**
 * Which of the two attempts is kept, and why.
 *
 * THE BUG THESE WERE WRITTEN FOR. The comparator led with hit COUNT and fell
 * back to score, so a broad rewrite returning eight weak passages beat a
 * precise first pass returning three strong ones. Since shouldExpand only
 * fires on relevance failures, ranking by volume answered a question nobody
 * had asked, and a payment-terms question came back holding a restaurant
 * deposit receipt.
 */
describe("choosing between the first attempt and the rewrite", () => {
  const hits = (n: number, score: number) =>
    execution(Array.from({ length: n }, () => ({ score })));

  /* THE EXACT SHAPE OF THE DEFECT. Eight weak beats three strong under the
     old rule; under the new one it does not. */
  it("does not prefer more results over better ones", async () => {
    mockQuery
      .mockResolvedValueOnce(hits(3, 0.88))
      .mockResolvedValueOnce(hits(8, 0.41));
    const r = await retrieve({
      userId: "u",
      userRole: "cto",
      query: "what are the payment terms",
      /* Rejected first, and the rewrite is no better: both wrong. */
      judge: async () => "irrelevant",
      expand: async () => "different words",
    });
    expect(r.expansionHelped).toBe(false);
    expect(r.execution.hits).toHaveLength(3);
  });

  /* A VERDICT OUTRANKS A SCORE. The judge decides relevance; the score only
     says how alike two pieces of text are. Getting this backwards was the
     first version of the fix. */
  it("keeps a lower-scoring rewrite the judge accepts over a rejected first pass", async () => {
    mockQuery
      .mockResolvedValueOnce(hits(3, 0.88))
      .mockResolvedValueOnce(hits(2, 0.52));
    let call = 0;
    const r = await retrieve({
      userId: "u",
      userRole: "cto",
      query: "what are the payment terms",
      judge: async () => (++call === 1 ? "irrelevant" : "relevant"),
      expand: async () => "invoice settlement wording",
    });
    expect(r.expansionHelped).toBe(true);
    expect(r.execution.hits[0].score).toBe(0.52);
  });

  it("keeps the first pass when the rewrite is judged wrong too", async () => {
    mockQuery
      .mockResolvedValueOnce(hits(2, 0.40))
      .mockResolvedValueOnce(hits(9, 0.95));
    const r = await retrieve({
      userId: "u",
      userRole: "cto",
      query: "what are the payment terms",
      judge: async () => "irrelevant",
      expand: async () => "different words",
    });
    /* Even at 0.95. A confident match on the wrong subject is the failure the
       judge exists to catch, and score cannot see it. */
    expect(r.expansionHelped).toBe(false);
    expect(r.execution.hits).toHaveLength(2);
  });

  /* When the first pass was thin rather than wrong, no verdict is in play and
     the scores are directly comparable. */
  it("prefers the stronger hit when neither was rejected", async () => {
    mockQuery
      .mockResolvedValueOnce(hits(4, 0.30))
      .mockResolvedValueOnce(hits(1, 0.81));
    const r = await retrieve({
      userId: "u",
      userRole: "cto",
      query: "q",
      /* No judge: the trigger is the weak top score, not a rejection. */
      expand: async () => "better words",
    });
    expect(r.expansionHelped).toBe(true);
    expect(r.execution.hits).toHaveLength(1);
  });

  /* More material of the SAME quality genuinely is more useful to a model, so
     count still decides, but only once score has said the two attempts found
     comparable things. */
  it("uses count only to break a genuine tie in quality", async () => {
    /* Both under SEMANTIC_SCORE_FLOOR, which is what makes the first pass
       thin enough to be worth retrying at all. Scores above the floor never
       reach this comparison, because no rewrite is attempted. */
    mockQuery
      .mockResolvedValueOnce(hits(2, 0.30))
      .mockResolvedValueOnce(hits(6, 0.32));
    const r = await retrieve({
      userId: "u",
      userRole: "cto",
      query: "q",
      expand: async () => "more words",
    });
    expect(r.expansionHelped).toBe(true);
    expect(r.execution.hits).toHaveLength(6);
  });

  it("does not pay to judge the rewrite when the first pass was not rejected", async () => {
    mockQuery
      .mockResolvedValueOnce(hits(1, 0.20))
      .mockResolvedValueOnce(hits(1, 0.90));
    let calls = 0;
    await retrieve({
      userId: "u",
      userRole: "cto",
      query: "q",
      judge: async () => {
        calls += 1;
        return "relevant";
      },
      expand: async () => "better words",
    });
    /* One call, on the first pass. A second opinion costs money and settles
       nothing when the scores already can. */
    expect(calls).toBe(1);
  });

  it("survives a judge that throws on the second attempt", async () => {
    mockQuery
      .mockResolvedValueOnce(hits(2, 0.30))
      .mockResolvedValueOnce(hits(2, 0.85));
    let call = 0;
    const r = await retrieve({
      userId: "u",
      userRole: "cto",
      query: "q",
      judge: async () => {
        if (++call === 1) return "irrelevant";
        throw new Error("judge unavailable");
      },
      expand: async () => "other words",
    });
    /* Falls back to comparing scores rather than failing the retrieval. */
    expect(r.expansionHelped).toBe(true);
  });
});

/**
 * The verdict a caller is actually holding.
 *
 * WHY IT IS REPORTED RATHER THAN INFERRED. firstWasRejected describes the
 * FIRST attempt. Once a rewrite is kept, that field is history, not a
 * description of the material the caller has. A caller left to work it out
 * from expanded/helped/firstWasRejected will get it wrong in one of the four
 * combinations, and the way it gets it wrong is by judging the same passages a
 * second time: same cost twice, and two parts of one turn able to disagree.
 */
describe("the verdict on whatever was kept", () => {
  const hits = (n: number, score: number) =>
    execution(Array.from({ length: n }, () => ({ score })));

  it("is unjudged when no judge was supplied", async () => {
    mockQuery.mockResolvedValue(hits(2, 0.9));
    const r = await retrieve({ userId: "u", userRole: "cto", query: "q" });
    expect(r.keptVerdict).toBe("unjudged");
  });

  it("is the first pass's verdict when no rewrite was tried", async () => {
    mockQuery.mockResolvedValue(hits(2, 0.9));
    const r = await retrieve({
      userId: "u",
      userRole: "cto",
      query: "q",
      judge: async () => "relevant",
    });
    /* Scored well and was judged relevant, so shouldExpand never fires. */
    expect(r.expanded).toBe(false);
    expect(r.keptVerdict).toBe("relevant");
  });

  /* THE COMBINATION THAT BREAKS AN INFERRING CALLER. The first attempt was
     rejected and the rewrite was accepted, so the material in hand is
     relevant while firstWasRejected is still true. */
  it("reports the rewrite's verdict once the rewrite is kept", async () => {
    mockQuery.mockResolvedValueOnce(hits(3, 0.88)).mockResolvedValueOnce(hits(2, 0.52));
    let call = 0;
    const r = await retrieve({
      userId: "u",
      userRole: "cto",
      query: "q",
      judge: async () => (++call === 1 ? "irrelevant" : "relevant"),
      expand: async () => "other words",
    });
    expect(r.firstWasRejected).toBe(true);
    expect(r.expansionHelped).toBe(true);
    expect(r.keptVerdict).toBe("relevant");
  });

  it("reports irrelevant when the first pass was kept after both were rejected", async () => {
    mockQuery.mockResolvedValueOnce(hits(3, 0.88)).mockResolvedValueOnce(hits(8, 0.41));
    const r = await retrieve({
      userId: "u",
      userRole: "cto",
      query: "q",
      judge: async () => "irrelevant",
      expand: async () => "other words",
    });
    expect(r.expansionHelped).toBe(false);
    expect(r.keptVerdict).toBe("irrelevant");
  });

  /* A rewrite kept on score alone carries no opinion, and saying "relevant"
     would be inventing one. The caller forms its own, which is the only
     branch where a second judge call is correct. */
  it("is unjudged when a rewrite won on score without being judged", async () => {
    mockQuery.mockResolvedValueOnce(hits(1, 0.20)).mockResolvedValueOnce(hits(1, 0.90));
    const r = await retrieve({
      userId: "u",
      userRole: "cto",
      query: "q",
      /* Not rejected, merely thin, so the second attempt is never judged. */
      judge: async () => "relevant",
      expand: async () => "better words",
    });
    expect(r.expansionHelped).toBe(true);
    expect(r.keptVerdict).toBe("unjudged");
  });

  /* THE COST GUARD. One question, one judgment of the first pass, whatever
     else happens. A second call is only ever made about the SECOND attempt. */
  it("judges the first pass exactly once", async () => {
    mockQuery.mockResolvedValueOnce(hits(2, 0.2)).mockResolvedValueOnce(hits(2, 0.3));
    let calls = 0;
    await retrieve({
      userId: "u",
      userRole: "cto",
      query: "q",
      judge: async () => {
        calls += 1;
        return "relevant";
      },
      expand: async () => "other words",
    });
    expect(calls).toBe(1);
  });
});
