/**
 * Every case here is a real measurement against the production index on
 * 2026-08-24, not an invented example.
 */
import { carriesEnoughToQuote, subjectWords } from "../confidence";

describe("messages that must never get a quoted document", () => {
  /* These are the THREE HIGHEST SCORING queries in the sample: 0.5000, 0.4000
     and 0.3000, above every genuine question. No score threshold can exclude
     them, which is the whole reason this function exists. */
  it.each(["yes", "thanks", "ok do that", "hi", "hey", "sure", "yeah", "ok"])(
    "%j carries nothing to be about",
    (m) => {
      expect(carriesEnoughToQuote(m)).toBe(false);
    },
  );

  it("a single subject word is not enough", () => {
    // "sales" appeared twice in the real query log with 5 keyword hits.
    expect(carriesEnoughToQuote("sales")).toBe(false);
    expect(subjectWords("sales")).toEqual(["sales"]);
  });
});

describe("questions that should still be answered", () => {
  it.each([
    "who is on the leadership team",
    "what is the policy on time off",
    "what is our onboarding process",
    "how do we handle expenses",
    "Nick Homyk",
  ])("%j carries a subject", (m) => {
    expect(carriesEnoughToQuote(m)).toBe(true);
  });

  it("does not reject a real question just because it is polite", () => {
    expect(carriesEnoughToQuote("hi, what is our refund policy please")).toBe(true);
  });
});

describe("subjectWords", () => {
  it("drops filler and keeps the subject", () => {
    expect(subjectWords("what is our refund policy").sort()).toEqual(["refund", "policy"].sort());
  });

  it("counts a repeated word once, so saying it twice is not more specific", () => {
    expect(subjectWords("payroll payroll payroll")).toEqual(["payroll"]);
  });

  it("ignores punctuation and case", () => {
    expect(subjectWords("Refund, POLICY!").sort()).toEqual(["policy", "refund"]);
  });

  it("is empty for a message with no subject at all", () => {
    expect(subjectWords("ok, thanks!")).toEqual([]);
  });
});
