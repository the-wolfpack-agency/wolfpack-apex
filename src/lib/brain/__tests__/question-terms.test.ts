/**
 * The reduction that keeps retrieval alive, tested where it now lives.
 *
 * Measured on 2026-08-30, three phrasings of one question against the same
 * document: "what is in the viaPeople work order" scored 0.900, "summarize the
 * viaPeople work order" 0.616, and "what does the viaPeople work order say"
 * found NOTHING. Keyword search ANDs its terms, so the question verb "say" had
 * to appear literally in a chunk. One scaffolding word zeroed out a perfect
 * match. After the reduction all three return the same document at 0.900.
 */

import { searchTermsFor, isQuestionShaped } from "@/lib/brain/question-terms";

describe("reducing a question to its topic", () => {
  it.each([
    ["what does the viaPeople work order say", "viaPeople work order"],
    ["what does the SOW say", "SOW"],
    ["what did the proposal say", "proposal"],
    ["what is in the contract", "contract"],
    ["what's in the SOW", "SOW"],
    ["summarize the onboarding document", "onboarding document"],
    ["summarise our contract", "contract"],
    ["give me a summary of the SOW", "SOW"],
    ["tell me about the viaPeople work order", "viaPeople work order"],
  ])("%s searches for %s", (question, expected) => {
    expect(searchTermsFor(question)).toBe(expected);
  });

  /* Searching the subject alone returns the whole document and buries the
     clause somebody actually wanted, so both halves survive. */
  it("keeps what was asked ABOUT alongside the subject", () => {
    expect(searchTermsFor("what does the SOW say about payment terms")).toBe("SOW payment terms");
    expect(searchTermsFor("what is in the contract about termination")).toBe(
      "contract termination",
    );
  });

  it("tolerates punctuation and casing the way people type", () => {
    expect(searchTermsFor("What does the SOW say?")).toBe("SOW");
    expect(searchTermsFor("  Summarize the contract.  ")).toBe("contract");
  });
});

/**
 * WHAT IT MUST NOT TOUCH. A reducer that quietly drops the subject is worse
 * than one that finds nothing: the first is wrong and looks right, the second
 * is honest. Anything unrecognised comes back exactly as it went in.
 */
describe("sentences it must leave alone", () => {
  it.each([
    /* A pronoun is not a topic. Searching for "it" matches nothing usefully
       and everything equally. */
    "what does it say",
    "what does this say",
    "what is in there",
    /* Not questions about a document at all. */
    "how many hours did we bill in July",
    "what did Sarah say in the meeting yesterday",
    "who is the account lead on viaPeople",
    "find the contract",
  ])("%s is returned unchanged", (question) => {
    expect(searchTermsFor(question)).toBe(question.trim());
    expect(isQuestionShaped(question)).toBe(false);
  });

  it("handles empty and whitespace input without inventing a topic", () => {
    expect(searchTermsFor("")).toBe("");
    expect(searchTermsFor("   ")).toBe("");
  });
});
