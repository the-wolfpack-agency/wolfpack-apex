/**
 * Tests for the get_org_facts tool (Phase 1 first tool).
 *
 * Covers:
 *   - Intent match: each of the 5 supported phrasings
 *   - Intent miss: unrelated questions
 *   - Handler: returns the facts as a Markdown answer + sources
 *   - Handler: graceful "no facts yet" when the table is empty
 *   - Handler: error path
 */

const mockFindRelevantFacts = jest.fn();
jest.mock("@/lib/assistant/learning", () => ({
  findRelevantFacts: (...a: any[]) => mockFindRelevantFacts(...a),
}));

import { getOrgFactsTool } from "@/lib/assistant/tools/get-org-facts";

const ctx = { userId: "u1", userRole: "dev" };

beforeEach(() => {
  mockFindRelevantFacts.mockReset();
});

describe("get_org_facts — intent matching", () => {
  test.each([
    ["what do we know about Acme?", "Acme"],
    ["tell me about Project Q3", "Project Q3"],
    ["what are the facts on Max Fuerst", "Max Fuerst"],
    ["What's known about the new pricing", "the new pricing"],
  ])("matches '%s' and extracts subject '%s'", (message, expectedSubject) => {
    const params = getOrgFactsTool.matchIntent(message);
    expect(params).not.toBeNull();
    expect(params?.subject).toBe(expectedSubject);
  });

  /* "DO WE HAVE ANYTHING ON X" MOVED TO SEARCH, and this is where that is
     pinned so the split cannot be undone by accident.

     It used to match here. This tool reads instinct_org_facts, which holds
     facts somebody verified by hand and is empty for almost every subject, so
     measured on 2026-08-28 "do we have anything on the porsche program" was
     answered "I don't have any verified facts about the porsche program yet"
     while the Brain held that client's entire SharePoint.

     "What do we know about X" asks what we have established, and stays here.
     "Do we have anything on X" asks whether anything exists at all, and only
     search can answer that honestly because only search can see everything.
     The split follows the words people chose. */
  test.each([
    "do we have anything on the Tuesday meeting?",
    "do we have anything on the porsche program",
    "what documents do we have about pcna",
    "how do i open a ticket",
    "schedule a meeting with Max",
    "did Acme pay this month",
    "",
    "hi",
  ])("does NOT match unrelated message '%s'", (message) => {
    expect(getOrgFactsTool.matchIntent(message)).toBeNull();
  });
});

describe("get_org_facts — handler", () => {
  test("returns formatted answer + sources when facts exist", async () => {
    mockFindRelevantFacts.mockResolvedValueOnce([
      { id: "f1", subject: "Acme", attribute: "owner", value: "Jorge" },
      { id: "f2", subject: "Acme", attribute: "status", value: "active" },
    ]);
    const result = await getOrgFactsTool.handler({ subject: "Acme" }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.factCount).toBe(2);
      expect(result.answer).toContain("Acme");
      expect(result.answer).toContain("Jorge");
      expect(result.answer).toContain("active");
      expect(result.sources).toHaveLength(2);
      expect(result.sources?.[0].url).toContain("/knowledge?fact=");
    }
  });

  test("returns graceful 'no facts yet' message when empty", async () => {
    mockFindRelevantFacts.mockResolvedValueOnce([]);
    const result = await getOrgFactsTool.handler({ subject: "Brand New" }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.factCount).toBe(0);
      expect(result.answer.toLowerCase()).toContain("don't have");
    }
  });

  test("returns internal failure when findRelevantFacts throws", async () => {
    mockFindRelevantFacts.mockRejectedValueOnce(new Error("DB down"));
    const result = await getOrgFactsTool.handler({ subject: "Acme" }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("internal");
      expect(result.message).toContain("DB down");
    }
  });

  test("caps at 10 facts (passes 10 as limit to findRelevantFacts)", async () => {
    mockFindRelevantFacts.mockResolvedValueOnce([]);
    await getOrgFactsTool.handler({ subject: "X" }, ctx);
    expect(mockFindRelevantFacts).toHaveBeenCalledWith("X", 10);
  });

  test("paramSchema rejects too-short or too-long subjects", () => {
    expect(getOrgFactsTool.paramSchema.safeParse({ subject: "a" }).success).toBe(false);
    expect(getOrgFactsTool.paramSchema.safeParse({ subject: "x".repeat(121) }).success).toBe(false);
    expect(getOrgFactsTool.paramSchema.safeParse({ subject: "Acme" }).success).toBe(true);
  });
});
