/**
 * Saying what we cannot reach, instead of paying a model to guess.
 *
 * Of ten prompts written the way somebody at a dealership types them,
 * seven matched no tool. They do not fail: they reach a model, which
 * answers fluently about warranty claims it has never seen, in a tone
 * indistinguishable from the answers backed by the client's own data.
 * That costs tokens AND teaches somebody to trust a sentence nothing
 * checked.
 */

export {};

import { detectUnreachable } from "../not-connected";

const intercepts = (m: string) => detectUnreachable(m) !== null;

describe("lookups about records nothing holds", () => {
  it.each([
    "which warranty claims are open?",
    "what is the status of the warranty claim?",
    "how many repair orders are still open?",
    "show me the parts on back order",
    "what did the technician write on the repair order?",
    "list the work orders from yesterday",
  ])("answers %p without a model", (m) => {
    expect(intercepts(m)).toBe(true);
  });

  it("names the system to connect, not just the limit", () => {
    /* A refusal that stops at "I can't" is a dead end. A client reading
       this knows what to do next. */
    const r = detectUnreachable("which warranty claims are open?")!;
    expect(r.answer).toContain("Connect your warranty system");
    expect(r.answer).toContain("what I can do");
  });
});

describe("what it must never take", () => {
  it.each([
    ["how do I submit a warranty claim?", "training, not data"],
    ["help me draft a reply about the warranty claim", "drafting"],
    ["draft a note about the repair order", "drafting"],
    ["why is this warranty claim denied?", "an explanation"],
    ["what should I say to the customer about the delay?", "advice"],
  ])("%s leaves %s to the model", (m) => {
    /* Intercepting a question a model should answer is the trespass
       failure again, and worse here, because this refuses rather than
       guesses. */
    expect(intercepts(m)).toBe(false);
  });

  it.each([
    "what is on my calendar this week?",
    "what was our revenue last quarter?",
    "compare contacts across systems",
    "what did we agree with the finance team",
  ])("leaves %p to the tool built for it", (m) => {
    expect(intercepts(m)).toBe(false);
  });

  it("does not fire on a domain word used in another sense", () => {
    /* "claims" alone is not warranty work. A document makes claims, and
       a matcher that took the bare noun would answer a question about a
       contract by talking about a DMS. */
    expect(intercepts("which claims does this document make")).toBe(false);
  });

  it("reads a verb as advice only when it is being asked of us", () => {
    /* "write" sat in the advice pattern on its own, so "what did the
       technician WRITE on the repair order" was read as somebody asking
       us to write something, and fell through to the model. */
    expect(intercepts("what did the technician write on the repair order?")).toBe(true);
    expect(intercepts("write me a note about the repair order")).toBe(false);
  });
});

/**
 * "Work order" belongs to documents, not to the DMS.
 *
 * This check runs in the API route and SHORT-CIRCUITS before retrieval, so a
 * phrase it claims never gets the chance to be a document question. That makes
 * an ambiguous noun expensive.
 *
 * Measured on the deployed URL 2026-08-29, walking a realistic task. Asked
 * "what are the payment terms in the viaPeople work order?" — about a document
 * sitting in SharePoint — the assistant replied:
 *
 *   "I cannot answer that yet: nothing connected to me holds your repair
 *    orders. Connect your DMS."
 *
 * The document exists, is indexed, and answers the question. "Work order" is a
 * standard business document long before it is a dealership record, and real
 * corpora are full of files called one.
 */
describe("ambiguous nouns do not short-circuit document questions", () => {
  it.each([
    "what are the payment terms in the viaPeople work order?",
    "show me the work order",
    "what does the work order say about payment",
  ])("lets %s reach retrieval", (q) => {
    expect(detectUnreachable(q)).toBeNull();
  });

  /* The unambiguous dealership terms stay claimed: nobody names a contract
     "repair order 4471". */
  it.each([
    "what is the status of repair order 4471?",
    "show me the repair orders from today",
  ])("still claims %s for the DMS", (q) => {
    expect(detectUnreachable(q)).not.toBeNull();
  });

  /* Warranty and parts are untouched by this change. */
  it("still claims warranty and parts lookups", () => {
    expect(detectUnreachable("what is the status of my warranty claim?")).not.toBeNull();
    expect(detectUnreachable("show me the parts order")).not.toBeNull();
  });
});
