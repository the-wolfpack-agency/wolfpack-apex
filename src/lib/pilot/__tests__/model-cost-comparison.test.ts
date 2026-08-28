/**
 * What the same work would have cost on somebody else's model.
 *
 * "We spent 77 cents" means nothing alone. It means something beside what the
 * identical token count costs at a premium vendor's published rate, which is
 * what a product routing everything to one large model actually pays.
 *
 * The arithmetic is simple enough that the tests are mostly about honesty:
 * a comparison must not invent a ratio, must not render a table of zeros as
 * though every model were free, and must not quietly present stale prices as
 * current.
 */
import {
  compareCosts,
  COMPARISON_PRICES,
  PRICES_RECORDED_ON,
  type TokenUsage,
} from "@/lib/pilot/model-cost-comparison";

/** The real sixty-day figures from production on 2026-08-28. */
const REAL: TokenUsage = {
  calls: 905,
  inputTokens: 852_969,
  outputTokens: 124_050,
  actualUsd: 0.7714,
};

describe("costing our own traffic at other vendors' rates", () => {
  it("prices the real production traffic", () => {
    const rows = compareCosts(REAL);
    const opus = rows.find((r) => r.label === "Claude Opus")!;
    const gpt4o = rows.find((r) => r.label === "GPT-4o")!;

    /* 852,969 in at $15/M plus 124,050 out at $75/M. */
    expect(opus.wouldHaveCostUsd).toBeCloseTo(22.1, 1);
    /* 852,969 in at $2.50/M plus 124,050 out at $10/M. */
    expect(gpt4o.wouldHaveCostUsd).toBeCloseTo(3.37, 1);
  });

  it("reports each as a multiple of what we actually paid", () => {
    const rows = compareCosts(REAL);
    const opus = rows.find((r) => r.label === "Claude Opus")!;
    expect(opus.multipleOfActual).toBeCloseTo(28.6, 0);
  });

  it("orders most expensive first, so the contrast leads", () => {
    const rows = compareCosts(REAL);
    const costs = rows.map((r) => r.wouldHaveCostUsd);
    expect([...costs].sort((a, b) => b - a)).toEqual(costs);
  });

  it("charges input and output at their different rates", () => {
    /* Output is priced higher everywhere, so a call that is all output must
       cost more than the same volume of input. Getting this backwards would
       understate the comparison and flatter us. */
    const allInput = compareCosts({ calls: 1, inputTokens: 1_000_000, outputTokens: 0, actualUsd: 1 });
    const allOutput = compareCosts({ calls: 1, inputTokens: 0, outputTokens: 1_000_000, actualUsd: 1 });
    for (const p of COMPARISON_PRICES) {
      const i = allInput.find((r) => r.label === p.label)!.wouldHaveCostUsd;
      const o = allOutput.find((r) => r.label === p.label)!.wouldHaveCostUsd;
      expect(o).toBeGreaterThan(i);
    }
  });
});

describe("what it refuses to claim", () => {
  /* A TABLE OF ZEROS WOULD READ AS "EVERY MODEL IS FREE". Returning nothing
     lets the page omit the section instead, which is the same rule the rest of
     this dashboard follows: no usage is not a finding about pricing. */
  it("returns nothing rather than a table of zeros when there is no usage", () => {
    expect(compareCosts({ calls: 0, inputTokens: 0, outputTokens: 0, actualUsd: 0 })).toEqual([]);
  });

  /* A ratio against zero spend is not a fact about efficiency, and Infinity
     rendered on a client dashboard is worse than no number. */
  it("gives no multiple when we spent nothing measurable", () => {
    const rows = compareCosts({ calls: 3, inputTokens: 1000, outputTokens: 100, actualUsd: 0 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.multipleOfActual === null)).toBe(true);
    expect(rows.every((r) => Number.isFinite(r.wouldHaveCostUsd))).toBe(true);
  });

  /* Prices go stale. A comparison against rates nobody has checked in six
     months is worse than no comparison, because it looks current. The date is
     carried to the page rather than living only in a comment. */
  it("carries the date its prices were recorded", () => {
    expect(PRICES_RECORDED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("compares against models a client would recognise, not a list of fifteen", () => {
    expect(COMPARISON_PRICES.length).toBeGreaterThanOrEqual(3);
    expect(COMPARISON_PRICES.length).toBeLessThanOrEqual(8);
    for (const p of COMPARISON_PRICES) {
      expect(p.inputPerMillion).toBeGreaterThan(0);
      expect(p.outputPerMillion).toBeGreaterThan(0);
      /* Output costs more than input at every vendor. A row where it does not
         is a typo, and a typo here understates what the alternative costs. */
      expect(p.outputPerMillion).toBeGreaterThan(p.inputPerMillion);
    }
  });
});
