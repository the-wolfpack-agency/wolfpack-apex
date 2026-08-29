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
  ])("%s reaches search and nothing else", async (prompt) => {
    expect(await claimants(prompt)).toEqual(["search"]);
  });

  it("leaves the imperative form working", async () => {
    expect(await claimants("find the contract")).toContain("search");
  });
});

/**
 * Summarise is not a search.
 *
 * It was captured here and handed to universal search, on the reasoning that
 * search is what can see the corpus. What search returns is a browsable LIST,
 * so somebody who asked for a summary received a filing cabinet. Measured on
 * the live deployment 2026-08-29: "summarize the onboarding document" returned
 * "Found 3 results" plus result rows, at zero tokens, because nothing
 * synthesised anything.
 *
 * Declining sends it to retrieval, which does synthesise. The same corpus
 * asked directly answered "The final payment is due within 30 days of the
 * software configuration in the production environment" in 552ms.
 */
describe("summarise goes to retrieval, not to search", () => {
  it.each(["summarize the SOW", "summarise the contract", "summarize the onboarding deck"])(
    "%s is not claimed as a search",
    (prompt) => {
      expect(matchDocumentQuestion(prompt)).toBeNull();
    },
  );

  /* THE RISK THAT HAD TO BE CHECKED. An older comment in search.ts warns that
     "summarize the SOW" once reached op_create_document, which would try to
     CREATE a document by that name. That tool still exists and its matcher
     still fires on the phrase, so declining here would be dangerous if a human
     could reach it. It is agentOnly and the dispatcher skips agent-only tools
     for a human caller, which is what makes this safe rather than lucky. */
  it("is claimed by nothing a human can reach", async () => {
    await import("@/lib/assistant/tools");
    const { getTools } = await import("@/lib/assistant/tools/registry");
    const humanClaimants = (
      getTools() as unknown as Array<{
        name: string;
        agentOnly?: boolean;
        matchIntent?: (m: string) => unknown;
      }>
    )
      .filter((t) => !t.agentOnly && typeof t.matchIntent === "function")
      .filter((t) => t.matchIntent!("summarize the onboarding document") != null)
      .map((t) => t.name);
    expect(humanClaimants).toEqual([]);
  });

  /* EXISTENCE QUESTIONS ARE UNTOUCHED. A list IS the right answer to "what
     documents do we have about X", and moving those to retrieval would break
     the one thing search is genuinely best at. */
  it.each([
    "what documents do we have about onboarding",
    "do we have anything on invoices",
    "is there anything on training",
  ])("still routes %s to search, where a list is the right answer", (prompt) => {
    expect(matchDocumentQuestion(prompt)).not.toBeNull();
  });
});
