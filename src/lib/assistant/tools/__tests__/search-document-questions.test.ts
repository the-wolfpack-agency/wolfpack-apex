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
 * Summarise stays with search, and the attempt to move it is worth recording.
 *
 * "summarize the onboarding document" returns a browsable LIST, so somebody
 * who asked for a summary receives a filing cabinet. The obvious fix was to
 * stop claiming it as a search and let it reach retrieval, which synthesises.
 *
 * That shipped, and validation against the deployed URL on 2026-08-29 showed
 * it made things worse:
 *
 *   before  "summarize the onboarding document" -> Found 3 results, plus three
 *           document rows in the results widget
 *   after   -> "I do not have anything on that yet, so I would rather ask than
 *           guess."
 *   after   "summarise the SOW" -> "Provide the statement of work (SOW)
 *           document or specify which SOW you are referring to, and I'll
 *           summarize it for you."
 *
 * Declining did not route to retrieval. It fell through to a model answer with
 * no document context, which then asked the reader to paste a document we
 * already hold.
 *
 * The premise was wrong: reaching the Brain is not what happens when nothing
 * claims a sentence. A real fix must route summarise to retrieval explicitly.
 */
describe("summarise is claimed by search, and that is currently the better answer", () => {
  it.each(["summarize the SOW", "summarise the contract", "summarize the onboarding deck"])(
    "%s is claimed, so the reader gets matching documents rather than nothing",
    (prompt) => {
      expect(matchDocumentQuestion(prompt)).not.toBeNull();
    },
  );

  /* THE MEASUREMENT THAT FORCED THE REVERT. Pinned so the next person to try
     this reads the result before repeating it: declining is not enough,
     because nothing downstream picks it up. */
  it("is claimed by search specifically, not left to fall through", async () => {
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
    expect(humanClaimants).toEqual(["search"]);
  });

  /* Existence questions are unaffected either way: a list IS the right answer
     to "what documents do we have about X". */
  it.each([
    "what documents do we have about onboarding",
    "do we have anything on invoices",
    "is there anything on training",
  ])("still routes %s to search", (prompt) => {
    expect(matchDocumentQuestion(prompt)).not.toBeNull();
  });
});
