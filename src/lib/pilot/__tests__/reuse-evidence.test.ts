/**
 * The reuse claim has to survive somebody checking it.
 *
 * The pitch was "compounding intelligence" — reuse GROWING as past answers
 * accumulate. Measured against production 2026-08-29, weekly repeat rate on
 * human traffic ran 94% to 100% from June to August with no upward trend. It is
 * not compounding; it is already at ceiling and always has been.
 *
 * The claim the data does support is stronger and needs no embellishment: a
 * small, stable set of questions carries almost all the volume. 1,242 asked
 * last week, 82 distinct.
 *
 * These tests exist because the failure mode of a claim like this is not being
 * wrong, it is being un-recheckable. Every number here comes from the same
 * tables that serve the product.
 */
import { assessReuse, describeReuse, type ReuseEvidence } from "@/lib/pilot/reuse-evidence";

/** Measured against production on 2026-08-29. */
const PRODUCTION: ReuseEvidence = {
  answersDelivered: 15780,
  modelCalls: 1196,
  modelSpendUsd: 1.4118,
  distinctQuestions: 82,
  questionsAsked: 1242,
};

describe("the measured claim", () => {
  const v = assessReuse(PRODUCTION);

  it("prices an answer at a fraction of a cent", () => {
    expect(v.costPerAnswerUsd).toBeLessThan(0.001);
    expect(v.costPerAnswerUsd).toBeCloseTo(1.4118 / 15780, 8);
  });

  it("shows most answers never reach a model", () => {
    expect(v.zeroModelShare).toBeGreaterThan(0.9);
  });

  it("shows a small set of questions carrying the volume", () => {
    expect(v.asksPerDistinctQuestion).toBeGreaterThan(10);
  });

  /* The counterfactual prices OUR calls, not a competitor's. That is the only
     version we can prove, and it is the one that survives a client asking
     where the number came from. */
  it("compares against our own measured per-call cost", () => {
    expect(v.costPerModelCallUsd).toBeCloseTo(1.4118 / 1196, 8);
    expect(v.counterfactualUsd).toBeCloseTo(15780 * (1.4118 / 1196), 4);
    expect(v.timesCheaper).toBeGreaterThan(10);
  });
});

describe("what it refuses to claim", () => {
  /* A ratio against zero spend is a marketing number. A product that has not
     run has not proved it is cheap. */
  it("reports no multiple when nothing was spent", () => {
    const v = assessReuse({ ...PRODUCTION, modelSpendUsd: 0, modelCalls: 0 });
    expect(v.timesCheaper).toBeNull();
  });

  it("reports no reuse ratio with no questions to divide", () => {
    const v = assessReuse({ ...PRODUCTION, distinctQuestions: 0 });
    expect(v.asksPerDistinctQuestion).toBeNull();
  });

  it("does not go negative when more calls than answers are recorded", () => {
    /* Model calls include routine and agent traffic that produces no chat
       answer, so the two counts are not subsets of one another. */
    const v = assessReuse({ ...PRODUCTION, modelCalls: 99999 });
    expect(v.zeroModelShare).toBe(0);
  });

  it("handles an empty deployment without dividing by zero", () => {
    const v = assessReuse({
      answersDelivered: 0,
      modelCalls: 0,
      modelSpendUsd: 0,
      distinctQuestions: 0,
      questionsAsked: 0,
    });
    expect(v.costPerAnswerUsd).toBe(0);
    expect(v.timesCheaper).toBeNull();
  });
});

describe("how it is stated", () => {
  const lines = describeReuse(PRODUCTION, assessReuse(PRODUCTION));

  it("leads with the mechanism, not the multiple", () => {
    expect(lines[0]).toMatch(/answers delivered/i);
  });

  /* THE CAVEAT TRAVELS WITH THE CLAIM. Separated, it gets dropped in the
     retelling, and it changes what the number means. */
  it("always carries the caveat about what is being compared", () => {
    expect(lines.join(" ")).toMatch(/not a competitor/i);
  });

  it("never claims the reuse rate is growing", () => {
    const text = lines.join(" ").toLowerCase();
    for (const word of ["compound", "growing", "increasing", "accelerat"]) {
      expect(`${word}: ${text.includes(word)}`).toBe(`${word}: false`);
    }
  });
});

/**
 * The compounding hypothesis, kept falsifiable rather than answered.
 *
 * The idea is that reuse GROWS as a workforce accumulates shared questions: a
 * dealer network where hundreds of people ask overlapping things should get
 * cheaper per answer over time, not merely cheap.
 *
 * Our own deployment cannot test that. It is a handful of internal accounts
 * plus automated traffic against a fixed corpus, and its repeat rate has sat at
 * ceiling since the first week. Reporting that flat line as "flat" would read
 * as a refutation of a hypothesis it never had the population to examine.
 */
import {
  assessReuseTrend,
  MIN_ASKERS_FOR_TREND,
  MIN_WEEKS_FOR_TREND,
  type ReuseWeek,
} from "@/lib/pilot/reuse-evidence";

const week = (n: number, asked: number, distinct: number, askers: number): ReuseWeek => ({
  week: `2026-0${n}`,
  asked,
  distinct,
  askers,
});

describe("the compounding hypothesis", () => {
  /* THE POINT OF THE WHOLE FUNCTION. Our instance must not produce a verdict. */
  it("refuses to answer from a handful of internal accounts", () => {
    const ours = Array.from({ length: 12 }, (_, i) => week(i, 1000, 80, 4));
    const r = assessReuseTrend(ours);
    expect(r.verdict).toBe("not_measurable");
    expect(r.reason).toMatch(/distinct people/i);
  });

  it("refuses to answer from too few weeks", () => {
    const short = Array.from({ length: MIN_WEEKS_FOR_TREND - 1 }, () => week(1, 500, 50, 100));
    expect(assessReuseTrend(short).verdict).toBe("not_measurable");
  });

  /* What the hypothesis holding would look like: more people, and the back
     half of the window repeating more than the front. */
  it("reports rising when a real workforce repeats more over time", () => {
    const weeks: ReuseWeek[] = [
      ...Array.from({ length: 5 }, () => week(1, 1000, 400, MIN_ASKERS_FOR_TREND + 30)),
      ...Array.from({ length: 5 }, () => week(2, 1000, 150, MIN_ASKERS_FOR_TREND + 30)),
    ];
    const r = assessReuseTrend(weeks);
    expect(r.verdict).toBe("rising");
    expect(r.reason).toMatch(/rose from/);
  });

  it("reports declining when questions keep getting more novel", () => {
    const weeks: ReuseWeek[] = [
      ...Array.from({ length: 5 }, () => week(1, 1000, 150, MIN_ASKERS_FOR_TREND + 30)),
      ...Array.from({ length: 5 }, () => week(2, 1000, 400, MIN_ASKERS_FOR_TREND + 30)),
    ];
    expect(assessReuseTrend(weeks).verdict).toBe("declining");
  });

  /* A couple of points of movement is noise at this scale and must not read as
     a trend, or every deployment "compounds" the moment it wobbles. */
  it("calls a small wobble flat rather than a trend", () => {
    const weeks = Array.from({ length: 10 }, (_, i) =>
      week(1, 1000, 200 + (i % 2) * 5, MIN_ASKERS_FOR_TREND + 30),
    );
    expect(assessReuseTrend(weeks).verdict).toBe("flat");
  });

  it("ignores weeks with no traffic rather than dividing by zero", () => {
    const weeks = [
      ...Array.from({ length: 10 }, () => week(1, 1000, 200, MIN_ASKERS_FOR_TREND + 30)),
      week(2, 0, 0, 0),
    ];
    expect(() => assessReuseTrend(weeks)).not.toThrow();
    expect(assessReuseTrend(weeks).rates).toHaveLength(10);
  });
});
