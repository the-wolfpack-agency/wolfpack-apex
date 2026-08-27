/**
 * "What does the SOW say" is the question a document library exists to answer.
 *
 * It reached NO tool until 2026-08-26, and "summarize the SOW" reached
 * op_create_document, which would have tried to CREATE a document by that name
 * rather than read the one already in the library. "find the contract" worked,
 * because that is how an engineer phrases it; everybody else asks a question.
 *
 * For a SharePoint engagement this is the whole interaction: connect a library,
 * ask about a document in it. The negatives matter as much as the positives,
 * because a matcher this shape is one careless widening away from claiming
 * every sentence containing the word "say".
 */

import { matchDocumentQuestion } from "@/lib/assistant/tools/search";

describe("questions about a document", () => {
  it.each([
    ["what does the SOW say", "SOW"],
    ["what's in the SOW", "SOW"],
    ["what is in the contract", "contract"],
    ["what does our contract say", "contract"],
    ["summarize the onboarding deck", "onboarding deck"],
    ["summarise the SOW", "SOW"],
    ["what did the proposal say", "proposal"],
  ])("%s searches for %s", (prompt, expected) => {
    expect(matchDocumentQuestion(prompt)).toBe(expected);
  });

  it("carries what was asked ABOUT into the query", () => {
    /* Searching the subject alone returns the whole document and buries the
       clause somebody actually wanted. */
    expect(matchDocumentQuestion("what does the SOW say about payment terms")).toBe(
      "SOW payment terms",
    );
    expect(matchDocumentQuestion("what does the contract say about termination")).toBe(
      "contract termination",
    );
  });

  it("tolerates punctuation and casing the way people type", () => {
    expect(matchDocumentQuestion("What does the SOW say?")).toBe("SOW");
    expect(matchDocumentQuestion("  whats in the contract  ")).toBe("contract");
  });
});

describe("sentences that are not questions about a document", () => {
  it.each([
    /* A pronoun carries no search terms, so this would return the library. */
    "what does it say",
    "what does this say",
    /* Not a document question at all. */
    "what does Jorge do",
    "what should I work on",
    "what are my tasks",
    "how is the pilot going",
    "what's on my calendar today",
    "what's the weather",
  ])("%s does not become a document search", (prompt) => {
    expect(matchDocumentQuestion(prompt)).toBeNull();
  });
});

describe("routing end to end", () => {
  async function claimants(prompt: string): Promise<string[]> {
    await import("@/lib/assistant/tools");
    const { getTools } = await import("@/lib/assistant/tools/registry");
    return (getTools() as unknown as Array<{ name: string; agentOnly?: boolean; matchIntent?: (m: string) => unknown }>)
      /* agentOnly tools never fire on a human turn, so they are not competing
         claimants for a person's sentence. */
      .filter((t) => !t.agentOnly && typeof t.matchIntent === "function" && t.matchIntent(prompt) != null)
      .map((t) => t.name);
  }

  it.each([
    "what does the SOW say",
    "what's in the SOW",
    "what does the contract say about payment",
    "summarize the SOW",
  ])("%s reaches search and nothing else", async (prompt) => {
    expect(await claimants(prompt)).toEqual(["search"]);
  });

  it("leaves the imperative form working", async () => {
    expect(await claimants("find the contract")).toContain("search");
  });
});
