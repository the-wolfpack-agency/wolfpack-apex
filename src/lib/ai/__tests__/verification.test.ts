/**
 * The verification policy, tested as a policy.
 *
 * TWO KINDS OF FAILURE, AND THE SECOND IS THE EXPENSIVE ONE.
 *
 * A missed bad answer ships something thin. A FALSE FLAG spends real money
 * asking a larger model to fix an answer that was already fine, on every
 * request that trips it, forever. That is how a cost-saving feature becomes a
 * cost center, so roughly half of these tests assert that good answers are left
 * alone.
 */
import { verifyAnswer, shouldEscalate } from "../verification";

const ok = (answer: string, question?: string) => verifyAnswer({ answer, question });

describe("verifyAnswer — answers that are fine", () => {
  it("passes an ordinary complete answer", () => {
    const v = ok("The invoice total is $4,200 and it was paid on 12 March.", "what is the invoice total?");
    expect(v.sufficient).toBe(true);
    expect(v.flags).toEqual([]);
  });

  it("passes a one-word answer without calling it truncated", () => {
    // "Yes" ends without punctuation and is a complete answer.
    expect(ok("Yes").sufficient).toBe(true);
  });

  it("passes an answer ending in a code fence", () => {
    const v = ok("Run this:\n\n```bash\nnpm run verify\n```");
    expect(v.sufficient).toBe(true);
  });

  it("passes an answer ending in a table row", () => {
    const v = ok("| Model | Cost |\n| --- | --- |\n| gpt-4o-mini | $0.01 |");
    expect(v.sufficient).toBe(true);
  });

  it("does not treat DISCUSSING a refusal as refusing", () => {
    /* The failure that would quietly double the cost of every policy question.
       This answer is a good answer about a refusal, not a refusal. */
    const v = ok(
      "The policy says we cannot share individual salaries, but the published band for that role is 45k to 60k.",
      "what does this role pay?",
    );
    expect(v.sufficient).toBe(true);
  });

  it("does not flag a correct answer that uses different words from the question", () => {
    /* THE TEST THAT KILLED THE RELEVANCE RULE. An earlier version judged
       relevance by shared content words; this answer shares none with its
       question and is perfect. The signal was wrong, not the threshold, so no
       rule in this module judges relevance now. It is the one check that
       genuinely needs a model. */
    const v = ok(
      "Revenue for the quarter came to 1.2 million, up 8 percent.",
      "how did the business perform financially in Q3?",
    );
    expect(v.sufficient).toBe(true);
  });

  it("never judges relevance from text, however unrelated the answer looks", () => {
    const v = ok(
      "Photosynthesis converts light energy into chemical energy inside chloroplasts.",
      "which Porsche Centers have not yet accepted their invitation?",
    );
    // Obviously wrong to a person, and undecidable by a rule. Left to the model.
    expect(v.sufficient).toBe(true);
  });
});

describe("verifyAnswer — answers that are not", () => {
  it("flags an empty answer", () => {
    expect(verifyAnswer({ answer: "   " })).toMatchObject({ sufficient: false, flags: ["empty"] });
  });

  it("flags an answer that stops mid-sentence", () => {
    const v = ok(
      "There are three things to consider here. The first is that the contract renews in March, and the second is that the",
    );
    expect(v.flags).toContain("truncated");
  });

  it("flags a refusal at the start", () => {
    expect(ok("I'm sorry, I can't help with that.").flags).toContain("refused");
  });

  it("flags a promise to do the work later", () => {
    /* Reads as progress until somebody waits for the thing that never comes. */
    expect(ok("I'll get back to you with those figures shortly.").flags).toContain("deferred");
  });

  it("flags placeholder text the model never filled in", () => {
    expect(ok("Dear [INSERT NAME], thank you for your order.").flags).toContain("placeholder");
  });

  it("flags an answer shorter than the caller required", () => {
    expect(verifyAnswer({ answer: "Fine.", minLength: 200 }).flags).toContain("truncated");
  });

  it("reports flags in a stable order with a reason", () => {
    // Dashboards join on these, and an unstable order makes two identical
    // failures look like two different ones.
    const a = ok("I'm sorry, I'll get back to you with [INSERT DETAIL]");
    const b = ok("I'm sorry, I'll get back to you with [INSERT DETAIL]");
    expect(a.flags).toEqual(b.flags);
    expect(a.reason.length).toBeGreaterThan(0);
  });
});

describe("shouldEscalate", () => {
  it("does not pay to overrule a refusal", () => {
    /* A model declining is very often the system working. Escalating it buys a
       larger model's willingness to do the thing the first one declined, which
       is the opposite of a safety feature. */
    const v = ok("I'm sorry, I can't help with that.");
    expect(v.sufficient).toBe(false);
    expect(shouldEscalate(v)).toBe(false);
  });

  it("escalates the failures a better model actually fixes", () => {
    for (const answer of [
      "",
      "I'll get back to you with those figures shortly.",
      "Dear [INSERT NAME], thanks.",
    ]) {
      expect(shouldEscalate(verifyAnswer({ answer }))).toBe(true);
    }
  });

  it("never escalates an answer that passed", () => {
    // The whole cost argument rests on this: the ordinary request pays once.
    expect(shouldEscalate(ok("The total is $4,200."))).toBe(false);
  });

  it("escalates when a refusal comes WITH a fixable flag", () => {
    /* Refusal alone is not worth paying for. A refusal that also stopped
       mid-sentence is a broken call, not a policy decision. */
    const v = ok(
      "I'm sorry, I cannot share that. However the published figures for the quarter show that revenue rose and the",
    );
    expect(v.flags).toContain("refused");
    expect(shouldEscalate(v)).toBe(true);
  });
});
