/**
 * Asking what a document says must produce an answer, not a filing cabinet.
 *
 * THE HISTORY, BECAUSE IT TOOK THREE ATTEMPTS. "What does the SOW say" reached
 * NO tool until 2026-08-26, so it was pointed at universal search, which made
 * it reachable. But search returns a browsable LIST, and somebody who asks for
 * a summary receives a list of filenames.
 *
 * The first fix simply stopped search claiming those sentences, expecting them
 * to fall through to retrieval. It shipped on 2026-08-29 and was reverted the
 * same day: they reached a model with no document context, which asked the
 * reader to paste a document the product already held. Strictly worse.
 *
 * The cause was never the routing. Search's matcher was doing two jobs at once
 * and only one of them was visible. It decided the route AND it reduced the
 * sentence to its topic, handing on "SOW payment" rather than "what does the
 * SOW say about payment". Removing the route silently removed the reduction,
 * and keyword search ANDs its terms, so the surviving question verb ("say")
 * had to appear literally in a chunk or nothing matched at all.
 *
 * The reduction now lives in `@/lib/brain/question-terms`, where retrieval can
 * use it, and it is tested there. This file asserts the routing half: content
 * questions are released, existence questions are not.
 */

import { matchDocumentQuestion } from "@/lib/assistant/tools/search";

/**
 * A CONTENT question asks what is inside a document. Only retrieval can answer
 * it, because only retrieval reads the text.
 */
describe("content questions are released to retrieval", () => {
  it.each([
    "what does the SOW say",
    "what does the SOW say about payment terms",
    "what does our contract say",
    "what did the proposal say",
    "what's in the SOW",
    "what is in the contract",
    "summarize the onboarding document",
    "summarize the contract",
  ])("%s is not claimed by search", (prompt) => {
    expect(matchDocumentQuestion(prompt)).toBeNull();
  });
});

/**
 * An EXISTENCE question asks what the library HOLDS. A list is the correct
 * answer, and moving these would break the one thing search is best at.
 */
describe("existence questions stay with search", () => {
  it.each([
    ["what documents do we have about onboarding", "onboarding"],
    ["do we have anything on invoices", "invoices"],
    ["is there anything on training", "training"],
  ])("%s still searches for %s", (prompt, expected) => {
    expect(matchDocumentQuestion(prompt)).toBe(expected);
  });
});

describe("routing end to end", () => {
  async function claimants(prompt: string): Promise<string[]> {
    await import("@/lib/assistant/tools");
    const { getTools } = await import("@/lib/assistant/tools/registry");
    return (
      getTools() as unknown as Array<{
        name: string;
        agentOnly?: boolean;
        matchIntent?: (m: string) => unknown;
      }>
    )
      /* agentOnly tools never fire on a human turn, so they are not competing
         claimants for a person's sentence. */
      .filter(
        (t) => !t.agentOnly && typeof t.matchIntent === "function" && t.matchIntent(prompt) != null,
      )
      .map((t) => t.name);
  }

  /* THE REGRESSION THAT WOULD HURT MOST. If some other tool claims these now
     that search has let go, they reach something that cannot read a document
     and the release has made things worse rather than better. In particular
     op_create_document once claimed "summarize the SOW" and would have tried
     to CREATE a document by that name. */
  it.each([
    "what does the SOW say",
    "summarize the onboarding document",
    "what is in the contract",
  ])("%s reaches no tool, so retrieval gets it", async (prompt) => {
    expect(await claimants(prompt)).toEqual([]);
  });

  it("leaves the imperative form working, because find really is a search", async () => {
    expect(await claimants("find the contract")).toContain("search");
  });

  it("leaves existence questions with search", async () => {
    expect(await claimants("what documents do we have about onboarding")).toEqual(["search"]);
  });
});
