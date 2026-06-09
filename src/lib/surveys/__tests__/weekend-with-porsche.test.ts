/**
 * Acceptance test: the "A Weekend with Porsche" survey is fully
 * expressible and enforceable with the survey-builder primitives.
 * If this passes, every question type in that survey works end-to-end
 * at the validation layer (the builder + responder render the same schema).
 */

import { OTHER_VALUE_PREFIX } from "../types";
import {
  validateSchema,
  validateAnswers,
  isQuestionActive,
  aggregateResponses,
} from "../validate";
import { weekendWithPorscheSchema, Q1_YES } from "../__fixtures__/weekend-with-porsche";

const other = (t: string) => `${OTHER_VALUE_PREFIX}${t}`;

describe("Weekend with Porsche survey", () => {
  test("schema is valid", () => {
    expect(validateSchema(weekendWithPorscheSchema)).toEqual({ ok: true });
  });

  test("YES path requires the contact block (incl. a valid email)", () => {
    // Missing contact details while interested → rejected.
    const missing = validateAnswers(weekendWithPorscheSchema, {
      q1_interest: Q1_YES,
      q2_eliminate: "Customer communication",
      q3_resources: ["Curated road trip guides"],
      q5_owner: "Sales Manager",
    });
    expect(missing.ok).toBe(false);

    // Full valid YES submission → accepted.
    const ok = validateAnswers(weekendWithPorscheSchema, {
      q1_interest: Q1_YES,
      c_first: "Dale",
      c_last: "Earnhardt",
      c_center: "Porsche Albany",
      c_email: "dale@porsche-albany.com",
      q2_eliminate: "Customer communication",
      q3_resources: ["Curated road trip guides", "CRM follow-up templates"],
      q5_owner: "Brand Ambassador",
    });
    expect(ok).toEqual({ ok: true });

    // Present but invalid email → rejected.
    const badEmail = validateAnswers(weekendWithPorscheSchema, {
      q1_interest: Q1_YES,
      c_first: "Dale",
      c_last: "E",
      c_center: "Porsche Albany",
      c_email: "not-an-email",
      q2_eliminate: "Internal buy-in",
      q3_resources: ["Luxury touchpoint ideas"],
      q5_owner: "Sales Manager",
    });
    expect(badEmail.ok).toBe(false);
  });

  test("NOT-interested path does not require the contact block", () => {
    const q1 = weekendWithPorscheSchema.questions.find((q) => q.id === "c_email")!;
    expect(isQuestionActive(q1, { q1_interest: "Not at this time" })).toBe(false);

    const ok = validateAnswers(weekendWithPorscheSchema, {
      q1_interest: "Not at this time",
      q2_eliminate: "Time required from my team",
      q3_resources: ["ROI / business case resources"],
      q5_owner: "General Sales Manager",
    });
    expect(ok).toEqual({ ok: true });
  });

  test("Q2 / Q5 accept an Other free-text answer (and require its text)", () => {
    const withOther = validateAnswers(weekendWithPorscheSchema, {
      q1_interest: "Not at this time",
      q2_eliminate: other("Legal review cycles"),
      q3_resources: ["Experience OS microsite"],
      q5_owner: other("Dealer Principal"),
    });
    expect(withOther).toEqual({ ok: true });

    const emptyOther = validateAnswers(weekendWithPorscheSchema, {
      q1_interest: "Not at this time",
      q2_eliminate: other("   "),
      q3_resources: ["Experience OS microsite"],
      q5_owner: "Sales Manager",
    });
    expect(emptyOther.ok).toBe(false);
  });

  test("Q3 enforces select-up-to-three", () => {
    const three = validateAnswers(weekendWithPorscheSchema, {
      q1_interest: "Not at this time",
      q2_eliminate: "Consistent execution",
      q3_resources: [
        "Customer invitation templates",
        "Curated road trip guides",
        "Dealer concierge playbook",
      ],
      q5_owner: "Sales Manager",
    });
    expect(three).toEqual({ ok: true });

    const four = validateAnswers(weekendWithPorscheSchema, {
      q1_interest: "Not at this time",
      q2_eliminate: "Consistent execution",
      q3_resources: [
        "Customer invitation templates",
        "Curated road trip guides",
        "Dealer concierge playbook",
        "CRM follow-up templates",
      ],
      q5_owner: "Sales Manager",
    });
    expect(four.ok).toBe(false);
  });

  test("aggregation buckets Other answers and skips sections", () => {
    const agg = aggregateResponses(weekendWithPorscheSchema, [
      { q2_eliminate: other("Legal review cycles"), q3_resources: ["Curated road trip guides"] },
      { q2_eliminate: "Customer communication", q3_resources: ["Curated road trip guides"] },
    ]);
    // Sections excluded from aggregation.
    expect(agg.find((a) => a.questionId === "intro")).toBeUndefined();
    const q2 = agg.find((a) => a.questionId === "q2_eliminate")!;
    expect(q2.otherCount).toBe(1);
    expect(q2.otherSamples).toContain("Legal review cycles");
    expect(q2.optionCounts!["Customer communication"]).toBe(1);
  });
});
