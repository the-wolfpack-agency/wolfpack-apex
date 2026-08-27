/**
 * The corpus Universal Search could not see.
 *
 * Search fanned out to chats, email, calendar, channels, curated knowledge,
 * CRM, inventory and deployments, and not to the documents. On 2026-08-27 that
 * corpus held 1,251 documents, 665 of them from SharePoint, every chunk
 * embedded, and none of it reachable from search. A question about what a
 * document said returned nothing while the document sat one table over.
 *
 * An empty result is indistinguishable from an empty corpus, which is the
 * worst shape of failure for a product sold on reading your systems.
 */
const mockQueryBrain = jest.fn();
jest.mock("@/lib/brain/query", () => ({ queryBrain: (...a: unknown[]) => mockQueryBrain(...a) }));

import { brainProvider } from "@/lib/search/providers/brain";

const ctx = { userId: "u1", workspaceId: "ws1" };

function hit(over: Partial<Record<string, unknown>> = {}) {
  return {
    document_id: "d1",
    document_filename: "Guest Feedback Summary.docx",
    chunk_idx: 0,
    content: "Guests praised the concierge team and the arrival experience.",
    snippet: "Guests praised the <mark>concierge</mark> team",
    score: 0.44,
    source: "semantic",
    web_url: null,
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQueryBrain.mockResolvedValue({ hits: [hit()] });
});

describe("brain provider", () => {
  it("returns a result for a question the corpus can answer", async () => {
    const out = await brainProvider.search("what did guests say", 5, ctx);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("brain");
    expect(out[0].title).toBe("Guest Feedback Summary.docx");
  });

  /* Retrieval returns chunks. Three chunks of one file are one result to a
     person scanning a list, and a list padded with the same filename three
     times is shorter than it looks. */
  it("collapses several chunks of one document into a single result", async () => {
    mockQueryBrain.mockResolvedValue({
      hits: [
        hit({ chunk_idx: 0, score: 0.41 }),
        hit({ chunk_idx: 1, score: 0.48 }),
        hit({ chunk_idx: 2, score: 0.39 }),
        hit({ document_id: "d2", document_filename: "Other.pdf", score: 0.37 }),
      ],
    });
    const out = await brainProvider.search("guests", 5, ctx);
    expect(out.map((r) => r.id)).toEqual(["d1", "d2"]);
  });

  it("keeps the best-scoring chunk of a document, not the first one seen", async () => {
    mockQueryBrain.mockResolvedValue({
      hits: [
        hit({ chunk_idx: 0, score: 0.41, snippet: "weaker" }),
        hit({ chunk_idx: 1, score: 0.48, snippet: "stronger" }),
      ],
    });
    const out = await brainProvider.search("guests", 5, ctx);
    expect(out[0].snippet).toBe("stronger");
  });

  /* Sending somebody to the file they already have access to beats showing
     them a fragment of it. */
  it("links to the original when the document came from SharePoint", async () => {
    mockQueryBrain.mockResolvedValue({
      hits: [hit({ web_url: "https://contoso.sharepoint.com/Shared%20Documents/g.docx" })],
    });
    const out = await brainProvider.search("guests", 5, ctx);
    expect(out[0].url).toBe("https://contoso.sharepoint.com/Shared%20Documents/g.docx");
  });

  it("falls back to the ingested copy when there is no original", async () => {
    const out = await brainProvider.search("guests", 5, ctx);
    expect(out[0].url).toBe("/brain?doc=d1");
  });

  it("respects the caller's limit after collapsing chunks", async () => {
    mockQueryBrain.mockResolvedValue({
      hits: Array.from({ length: 9 }, (_, i) =>
        hit({ document_id: `d${i}`, document_filename: `F${i}.pdf`, score: 0.4 - i * 0.001 }),
      ),
    });
    const out = await brainProvider.search("guests", 3, ctx);
    expect(out).toHaveLength(3);
  });

  /* Over-fetch, because collapsing to documents would otherwise return fewer
     rows than asked for whenever a file matched more than once. */
  it("asks retrieval for more chunks than the row limit", async () => {
    await brainProvider.search("guests", 5, ctx);
    expect(mockQueryBrain).toHaveBeenCalledWith(
      expect.objectContaining({ query: "guests", limit: 15 }),
    );
  });

  /* An empty query has nothing to be relevant to. Returning nothing is right,
     and the other providers still fill the page. */
  it("does not run retrieval for an empty query", async () => {
    expect(await brainProvider.search("   ", 5, ctx)).toEqual([]);
    expect(mockQueryBrain).not.toHaveBeenCalled();
  });

  it("scopes retrieval to the asking user", async () => {
    await brainProvider.search("guests", 5, ctx);
    expect(mockQueryBrain).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1" }));
  });

  it("is always enabled: the corpus is not a per-tenant connector", () => {
    expect(brainProvider.isEnabled(ctx)).toBe(true);
  });
});
