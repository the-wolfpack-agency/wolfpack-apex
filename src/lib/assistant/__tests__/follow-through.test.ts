/**
 * "ok, do that" must not be dispatched as a fresh question.
 *
 * Measured on production 2026-08-23, turn three of a four-turn
 * conversation: it carried no subject, matched nothing, fell through to
 * document retrieval, and returned a chunk of an unrelated spreadsheet
 * with complete confidence.
 */

export {};

import {
  extractOffer,
  isFollowThrough,
  resolveFollowThrough,
} from "../follow-through";

describe("what counts as agreeing with the last turn", () => {
  it.each([
    "ok, do that",
    "ok do it",
    "yes",
    "yes please",
    "go ahead",
    "do it",
    "run it",
    "sure",
    "sounds good",
    "Perfect!",
  ])("treats %p as a follow-through", (m) => {
    expect(isFollowThrough(m)).toBe(true);
  });

  it.each([
    "do that for the Detroit store",
    "ok but only the warranty ones",
    "run my morning",
    "yes, what about the other dealership",
    "what can you do",
  ])("leaves %p alone, because it carries its own subject", (m) => {
    /* A false positive re-runs the last offer instead of answering what
       somebody actually asked, which is a worse failure than the one this
       fixes. Anything with an object in it falls through. */
    expect(isFollowThrough(m)).toBe(false);
  });

  it("does not treat a long message as a bare acknowledgement", () => {
    expect(isFollowThrough("ok ".repeat(30))).toBe(false);
  });
});

describe("what was actually on offer", () => {
  it("takes the first command the assistant put in backticks", () => {
    const prev =
      "Whole jobs, in one command\n\n- `run my morning` gathers your day.\n- `where do things stand` shows what is blocked.";
    expect(extractOffer(prev)).toBe("run my morning");
  });

  it("does not offer back a link or a code identifier", () => {
    expect(extractOffer("See `/settings` for more")).toBeNull();
    expect(extractOffer("the `get_financials_metric` tool")).toBeNull();
  });

  it("treats a refusal as no offer at all", () => {
    /* The exact previous turn from the production conversation. Agreeing
       with a refusal must not run the thing that was just denied. */
    const refusal =
      "That tool (get_financials_metric) needs a higher-privilege role than yours.";
    expect(extractOffer(refusal)).toBeNull();
  });

  it("treats a no-confident-answer turn as no offer", () => {
    const prev =
      "I don't have a confident answer for that. Could you rephrase? Try one of these instead: `run my morning`";
    expect(extractOffer(prev)).toBeNull();
  });
});

describe("what happens on the turn itself", () => {
  it("runs what was offered", () => {
    const r = resolveFollowThrough("You could try `where do things stand` next.");
    expect(r.rewritten).toBe("where do things stand");
    expect(r.clarify).toBeUndefined();
  });

  it("asks, rather than guessing, when nothing was offered", () => {
    /* The whole point. Retrieval on a subjectless message is how a
       spreadsheet chunk became an answer. */
    const r = resolveFollowThrough("Here is a summary of your week.");
    expect(r.rewritten).toBeUndefined();
    expect(r.clarify).toContain("did not offer anything specific");
  });

  it("asks when there is no previous turn at all", () => {
    expect(resolveFollowThrough(null).clarify).toBeTruthy();
    expect(resolveFollowThrough("").clarify).toBeTruthy();
  });
});
