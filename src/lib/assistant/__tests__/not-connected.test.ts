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
