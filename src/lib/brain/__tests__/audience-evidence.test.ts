/**
 * The audience gate, proved on the path that actually runs.
 *
 * `brain.retrieval_audience_filtered` read ZERO for ninety days while
 * /playbook told clients the assistant "only quoted what their role may read".
 * That number has two possible meanings and they are opposite: nothing was
 * ever withheld, or the control never runs. On 2026-08-26 six separate
 * controls in this product turned out to be the second kind.
 *
 * TRIAGE RESULT, and it is a third thing neither guess covered. The control
 * WAS running and the claim WAS true: keywordSearch has always applied the
 * audience predicate inside the SQL. But the event was emitted only from the
 * SEMANTIC branch of queryBrain, which is gated on `isEmbeddingConfigured()`,
 * and no embedding deployment has ever existed on this tenant. The instrument
 * was bolted to a road nobody drives.
 *
 * A working control with no evidence is indistinguishable from a broken one to
 * anybody auditing it, which is the whole reason the number is on a page.
 *
 * So: audience.test.ts proves the predicate withholds the right rows. THIS
 * proves queryBrain reports it, on the ordinary keyword path, with no
 * embedding configured and nothing opted into. Together they mean the zero can
 * finally be read as good news.
 */

const mockTrackEvent = jest.fn();
const mockKeywordSearchWithAudience = jest.fn();
const mockLogQuery = jest.fn().mockResolvedValue(1);

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));
jest.mock("../repo", () => ({
  keywordSearchWithAudience: (...a: unknown[]) => mockKeywordSearchWithAudience(...a),
  logQuery: (...a: unknown[]) => mockLogQuery(...a),
  markQueryCited: jest.fn(),
  describeDocuments: async () => new Map(),
}));
/* NOT CONFIGURED, deliberately. This is the production shape: the semantic
   half has never been switched on here, so a test that enables it would prove
   nothing about the number the operator is actually looking at. */
jest.mock("../embedder", () => ({
  isEmbeddingConfigured: () => false,
  embedBatch: jest.fn(),
}));
jest.mock("../qdrant", () => ({ searchBrain: jest.fn() }));

import { queryBrain } from "../query";

function hit(id: string) {
  return {
    chunk_id: id,
    document_id: `d-${id}`,
    chunk_idx: 0,
    filename: "handbook.pdf",
    kind: "policy",
    content: "text",
    score: 0.5,
    headline: "text",
  };
}

const OPTS = { query: "holiday policy", userId: "u1", userRole: "sales" };

beforeEach(() => {
  jest.clearAllMocks();
  mockKeywordSearchWithAudience.mockResolvedValue({ hits: [hit("a")], withheld: 0 });
});

const filtered = () =>
  mockTrackEvent.mock.calls.filter((c) => c[0] === "brain.retrieval_audience_filtered");

describe("the audience gate reports itself", () => {
  it("fires on an ordinary query with no embedding configured", async () => {
    /* THE ONE THAT MATTERS. Nothing opted in, semantic off, which is exactly
       how every real query on this deployment has ever run. */
    mockKeywordSearchWithAudience.mockResolvedValue({ hits: [hit("a")], withheld: 3 });
    await queryBrain(OPTS);

    const calls = filtered();
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toBe("sales");
    expect(calls[0][3]).toMatchObject({ withheld: 3, returned: 1, stage: "keyword" });
  });

  it("reports the withheld count even when the role may read NOTHING", async () => {
    /* The case most worth reporting, and the one a naive query loses: no rows
       come back at all, so a count derived from the returned rows would say
       zero withheld at the exact moment everything was withheld. */
    mockKeywordSearchWithAudience.mockResolvedValue({ hits: [], withheld: 7 });
    await queryBrain(OPTS);
    expect(filtered()[0][3]).toMatchObject({ withheld: 7, returned: 0 });
  });

  it("stays silent when the role could read everything it matched", async () => {
    /* The other half, and the reason a zero will be meaningful from now on. If
       it fired on every query the count would be noise rather than evidence. */
    await queryBrain(OPTS);
    expect(filtered()).toHaveLength(0);
  });

  it("names the stage, so keyword and semantic evidence stay distinguishable", async () => {
    mockKeywordSearchWithAudience.mockResolvedValue({ hits: [hit("a")], withheld: 1 });
    await queryBrain(OPTS);
    expect(filtered()[0][3].stage).toBe("keyword");
  });

  it("passes the asking role down to the query rather than filtering after it", async () => {
    /* A restricted document that is ranked and headlined before being dropped
       has already been read by the process that ranked it. */
    await queryBrain(OPTS);
    expect(mockKeywordSearchWithAudience).toHaveBeenCalledWith(
      "holiday policy",
      expect.any(Number),
      expect.objectContaining({ role: "sales" }),
    );
  });
});
