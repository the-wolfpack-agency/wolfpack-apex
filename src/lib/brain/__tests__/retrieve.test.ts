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

const execution = (hits: Array<{ score: number }>) => ({
  query: "q",
  hits: hits.map((h, i) => ({ ...h, chunk_id: `c${i}`, content: "x", document_filename: "f" })),
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
