/**
 * The number the product is sold on.
 *
 * The router page reported spend, which model was picked and how the
 * tiers split. All of that describes the calls we DID make. None of it
 * describes the ones we did not, which is the actual claim: it uses AI
 * only when it has to.
 *
 * Production, thirty days to 2026-08-23: 3,536 assistant replies, 47 from
 * a model, 98.7% answered without one. A claim cannot regress. A number
 * can, which is the point of putting it on a page.
 */

export {};

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({ safeQuery: (...a: unknown[]) => mockSafeQuery(...a) }));

beforeEach(() => jest.clearAllMocks());

function totals(replies: number, modelReplies: number, tokens: number) {
  return {
    rows: [
      { replies: String(replies), model_replies: String(modelReplies), tokens: String(tokens) },
    ],
  };
}
const sources = { rows: [{ source: "tool", n: "2172" }, { source: null, n: "7" }] };

describe("the share", () => {
  it("reports production's own numbers correctly", async () => {
    mockSafeQuery.mockResolvedValueOnce(totals(3536, 47, 101_644)).mockResolvedValueOnce(sources);
    const { getDeterministicShare } = await import("../deterministic-share");
    const s = await getDeterministicShare(30);
    expect(s.share).toBeCloseTo(0.9867, 3);
    expect(s.modelReplies).toBe(47);
  });

  it("reports tokens per model reply, which is the lever that still moves", async () => {
    /* With call volume already at 1.3% there is almost nothing to win by
       answering fewer questions with a model, and everything to win by
       making each of those calls smaller. */
    mockSafeQuery.mockResolvedValueOnce(totals(3536, 47, 101_644)).mockResolvedValueOnce(sources);
    const { getDeterministicShare } = await import("../deterministic-share");
    expect((await getDeterministicShare(30)).avgTokensPerModelReply).toBe(2163);
  });

  it("names where the zero-token answers came from", async () => {
    mockSafeQuery.mockResolvedValueOnce(totals(100, 1, 500)).mockResolvedValueOnce(sources);
    const { getDeterministicShare } = await import("../deterministic-share");
    const s = await getDeterministicShare(30);
    expect(s.bySource[0]).toEqual({ source: "tool", replies: 2172 });
    /* A row with no source is still a row. Dropping it would quietly
       change the total the reader is adding up. */
    expect(s.bySource[1]).toEqual({ source: "unattributed", replies: 7 });
  });
});

describe("what it says when it cannot say anything", () => {
  it("reports zero rather than a perfect score on an empty window", async () => {
    /* Nought replies is not "100% deterministic". A metric that reads
       best when nothing has happened is the kind somebody quotes once and
       never trusts again. */
    mockSafeQuery.mockResolvedValueOnce(totals(0, 0, 0));
    const { getDeterministicShare } = await import("../deterministic-share");
    const s = await getDeterministicShare(30);
    expect(s.share).toBe(0);
    expect(s.replies).toBe(0);
  });

  it("does not divide by zero when no model was used at all", async () => {
    mockSafeQuery.mockResolvedValueOnce(totals(500, 0, 0)).mockResolvedValueOnce({ rows: [] });
    const { getDeterministicShare } = await import("../deterministic-share");
    const s = await getDeterministicShare(30);
    expect(s.share).toBe(1);
    expect(s.avgTokensPerModelReply).toBe(0);
  });

  it("degrades to empty when the query fails, rather than taking the page down", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    const { getDeterministicShare } = await import("../deterministic-share");
    expect((await getDeterministicShare(30)).replies).toBe(0);
  });
});
