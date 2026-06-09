import { computeInsights } from "../insights";
import type { SurveyResponse, SurveySchema } from "../types";

const schema: SurveySchema = {
  questions: [
    { id: "q1", type: "single_choice", label: "Pick", required: true, options: ["A", "B"] },
    { id: "q2", type: "rating", label: "Score", required: false, max: 5 },
  ],
};

function resp(over: Partial<SurveyResponse>): SurveyResponse {
  return {
    id: "r", surveyId: "s", answers: {}, respondentFingerprint: null,
    qrScanId: null, durationMs: null, device: null, country: null,
    referrer: null, submittedAt: "2026-06-09T00:00:00.000Z", ...over,
  };
}

describe("computeInsights", () => {
  test("completion rate = responses / views, capped at 1", () => {
    const i = computeInsights(schema, 10, [resp({}), resp({}), resp({})]);
    expect(i.views).toBe(10);
    expect(i.responses).toBe(3);
    expect(i.completionRate).toBe(0.3);
  });

  test("zero views → completion rate 0 (no divide-by-zero)", () => {
    expect(computeInsights(schema, 0, [resp({})]).completionRate).toBe(0);
  });

  test("more responses than views caps rate at 1", () => {
    expect(computeInsights(schema, 1, [resp({}), resp({})]).completionRate).toBe(1);
  });

  test("average duration over responses that reported one", () => {
    const i = computeInsights(schema, 5, [
      resp({ durationMs: 1000 }),
      resp({ durationMs: 3000 }),
      resp({ durationMs: null }),
    ]);
    expect(i.avgDurationMs).toBe(2000);
  });

  test("attribution tallies device/country/referrer with unknown bucket", () => {
    const i = computeInsights(schema, 3, [
      resp({ device: "mobile", country: "US" }),
      resp({ device: "mobile", country: null }),
      resp({ device: "desktop", referrer: "instagram.com" }),
    ]);
    expect(i.byDevice).toEqual({ mobile: 2, desktop: 1 });
    expect(i.byCountry.US).toBe(1);
    expect(i.byCountry.unknown).toBe(2); // two responses had no country
    expect(i.byReferrer["instagram.com"]).toBe(1);
  });

  test("per-question aggregate is included", () => {
    const i = computeInsights(schema, 2, [
      resp({ answers: { q1: "A", q2: 4 } }),
      resp({ answers: { q1: "A", q2: 2 } }),
    ]);
    const q1 = i.perQuestion.find((p) => p.questionId === "q1")!;
    expect(q1.optionCounts!.A).toBe(2);
    const q2 = i.perQuestion.find((p) => p.questionId === "q2")!;
    expect(q2.average).toBe(3);
  });
});
