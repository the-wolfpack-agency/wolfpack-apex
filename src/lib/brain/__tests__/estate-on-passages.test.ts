/** @jest-environment node */
/**
 * A retrieved passage says whose material it is.
 *
 * WHY THE ASSISTANT STILL SEARCHES EVERYTHING. This tenant holds work for ten
 * estates, and an internal question about how we structured a launch should
 * find the answer wherever we did it. Narrowing search by default would take
 * that away to prevent a rarer problem, and a filter people set once and forget
 * silently shrinks every answer afterwards.
 *
 * WHAT MUST NOT HAPPEN is an answer about one client resting on another
 * client's document without saying so. That reads exactly like a correct
 * answer, which is the failure mode this whole codebase keeps producing: two
 * different situations spelled identically. Carrying the estate on the passage
 * makes the wrong thing legible rather than preventing it, the same way the
 * relevance judge does.
 *
 * BOTH HALVES OR NEITHER. A semantic hit comes from the vector store, whose
 * payload holds no estate. Labeling only keyword hits would leave half the
 * passages blank, and a blank estate reads as "belongs to nobody" rather than
 * "was not looked up" — worse than not labeling at all.
 */

import { describeDocuments } from "../repo";

const mockQuery = jest.fn();
jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a) }));

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DATABASE_URL = "postgres://test";
});

describe("the estate travels with the document description", () => {
  it("is read for every document a search touched", async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: "d1", summary: "s", topics: ["t"], web_url: "u", estate: "pcna" }],
    });
    const out = await describeDocuments(["d1"]);
    expect(out.get("d1")).toMatchObject({ estate: "pcna" });
  });

  /* Selected in the SQL, because a column nobody asks for comes back
     undefined and reads as "no estate" rather than as a missing SELECT. */
  it("asks the database for it", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await describeDocuments(["d1"]);
    expect(String(mockQuery.mock.calls[0][0])).toMatch(/\bestate\b/);
  });

  /* A document uploaded by hand belongs to no source. Null is the honest
     answer and is not the same as belonging to nobody. */
  it("is null for a document with no source", async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: "d1", summary: null, topics: null, web_url: null, estate: null }],
    });
    expect((await describeDocuments(["d1"]))?.get("d1")?.estate).toBeNull();
  });

  /* THE SHARED PATH IS THE POINT. This function feeds both the keyword branch
     and the semantic branch of the merge, so one lookup labels both. If the
     estate were added to the keyword SQL alone, semantic hits would arrive
     unlabeled and nothing would say why. */
  it("is the single lookup both halves of retrieval use", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { id: "kw", summary: null, topics: null, web_url: null, estate: "pcna" },
        { id: "sem", summary: null, topics: null, web_url: null, estate: "ford" },
      ],
    });
    const out = await describeDocuments(["kw", "sem"]);
    expect(out.get("kw")?.estate).toBe("pcna");
    expect(out.get("sem")?.estate).toBe("ford");
    /* One round trip for both, not one per branch. */
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  /* Descriptions are decoration; a hit without one is still a hit. The estate
     must not be the thing that turns a database hiccup into a failed search. */
  it("degrades to no description rather than throwing", async () => {
    mockQuery.mockRejectedValue(new Error("connection terminated"));
    await expect(describeDocuments(["d1"])).resolves.toEqual(new Map());
  });
});
