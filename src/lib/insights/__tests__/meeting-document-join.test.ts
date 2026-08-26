/**
 * The join a single system cannot do.
 *
 * The calendar knows there is a dealer review on Thursday. The library knows
 * which documents cover it. Neither knows the other exists, so nobody was
 * asking the library what the MEETING is about: the brain search already in
 * meeting prep looks up each ATTENDEE by name, which finds facts about people.
 *
 * The two things that make it safe to ship are here: it must be gated by who
 * is asking, and it must degrade to nothing rather than failing the brief.
 */
const mockQueryBrain = jest.fn();
jest.mock("@/lib/brain/query", () => ({
  queryBrain: (...a: unknown[]) => mockQueryBrain(...a),
}));

import { fetchMeetingDocumentsForTests as fetchDocs } from "../meeting-prep-sources";

const CTX = { workspaceId: "w1", userId: "u1", userRole: "sales" };

beforeEach(() => mockQueryBrain.mockReset());

describe("what to read before a meeting", () => {
  it("searches on the meeting subject, not the attendees", async () => {
    mockQueryBrain.mockResolvedValue({ hits: [] });
    await fetchDocs(CTX, "Q4 dealer review");
    expect(mockQueryBrain).toHaveBeenCalledWith(
      expect.objectContaining({ query: "Q4 dealer review" }),
    );
  });

  /* THE GATE. queryBrain applies the audience filter, and it can only do that
     if it is told who is asking. A brief assembled from documents the reader
     may not open arrives looking like something the system decided they
     needed, which is the most efficient way imaginable to leak one. */
  it("passes the caller's role so the audience gate applies", async () => {
    mockQueryBrain.mockResolvedValue({ hits: [] });
    await fetchDocs(CTX, "Q4 dealer review");
    expect(mockQueryBrain).toHaveBeenCalledWith(
      expect.objectContaining({ userRole: "sales", userId: "u1" }),
    );
  });

  it("describes the document rather than quoting the chunk", async () => {
    mockQueryBrain.mockResolvedValue({
      hits: [
        {
          document_id: "d1",
          document_filename: "Dealer Review Pack.pdf",
          document_summary: "The quarterly dealer review pack for Porsche Centers.",
          document_topics: ["dealer review", "quarterly"],
          web_url: "https://example.sharepoint.com/x",
          content: "ted eLearning suite and supported by",
        },
      ],
    });
    const out = await fetchDocs(CTX, "dealer review");
    expect(out).toHaveLength(1);
    expect(out[0].summary).toBe("The quarterly dealer review pack for Porsche Centers.");
    /* The mid-sentence fragment is exactly what a pre-read list must not show:
       it cannot tell anybody whether the document is worth their time. */
    expect(out[0].summary).not.toContain("ted eLearning");
    expect(out[0].webUrl).toBe("https://example.sharepoint.com/x");
  });

  it("shows each document once, however many chunks matched", async () => {
    mockQueryBrain.mockResolvedValue({
      hits: [
        { document_id: "d1", document_filename: "A.pdf", content: "x" },
        { document_id: "d1", document_filename: "A.pdf", content: "y" },
        { document_id: "d2", document_filename: "B.pdf", content: "z" },
      ],
    });
    const out = await fetchDocs(CTX, "review");
    expect(out.map((d) => d.documentId)).toEqual(["d1", "d2"]);
  });

  /* A brief without documents is still a brief. A brief that fails to render
     because the library was unreachable is not. */
  it("degrades to nothing when the library is unreachable", async () => {
    mockQueryBrain.mockRejectedValue(new Error("qdrant down"));
    expect(await fetchDocs(CTX, "review")).toEqual([]);
  });

  it("does not search on an empty subject", async () => {
    expect(await fetchDocs(CTX, "  ")).toEqual([]);
    expect(mockQueryBrain).not.toHaveBeenCalled();
  });
});
