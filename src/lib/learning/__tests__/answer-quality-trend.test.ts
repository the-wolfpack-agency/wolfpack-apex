/**
 * Is the answer quality actually moving, or are we just saying it is?
 *
 * Four events record every time the product caught something: a retrieval
 * judged irrelevant, an answer refused promotion, a response flagged, a draft
 * corrected by a second model. All four were written and none was ever read,
 * which made "the trend is measurable" a claim about the events existing.
 *
 * The assertions below are mostly about ONE idea: a catch count without its
 * denominator is unreadable, and every way of hiding that is a bug.
 */
const mockQuery = jest.fn();
jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a) }));

import {
  getAnswerQualityTrend,
  flaggedPerThousand,
  correctionRate,
  type QualityWeek,
} from "../answer-quality-trend";

const WEEK = (o: Partial<QualityWeek> = {}): QualityWeek => ({
  weekStart: "2026-08-24",
  modelCalls: 1000,
  flagged: 2,
  reviewed: 100,
  corrected: 30,
  irrelevantRetrievals: 5,
  notPromoted: 1,
  ...o,
});

beforeEach(() => mockQuery.mockReset());

describe("rates that refuse to lie about an empty denominator", () => {
  /* The bug this exists to prevent: flagged falls from ten to two. That is
     good news if volume held, and hidden bad news if volume collapsed or a
     checker stopped running. The same number, opposite meanings. */
  it("reports null, not zero, when nothing was called", () => {
    expect(flaggedPerThousand(WEEK({ modelCalls: 0, flagged: 0 }))).toBeNull();
  });

  it("reports null, not zero, when nothing was reviewed", () => {
    expect(correctionRate(WEEK({ reviewed: 0, corrected: 0 }))).toBeNull();
  });

  it("computes the flagged rate against calls", () => {
    expect(flaggedPerThousand(WEEK({ modelCalls: 500, flagged: 1 }))).toBe(2);
  });

  /* Measured against reviewed, not against calls: the question is whether the
     second model earns its cost, and unreviewed calls say nothing either way. */
  it("computes the correction rate against reviews, not calls", () => {
    expect(correctionRate(WEEK({ modelCalls: 10_000, reviewed: 50, corrected: 20 }))).toBe(0.4);
  });
});

describe("reading the trend", () => {
  function respond(rows: Record<string, string>[]) {
    mockQuery.mockResolvedValueOnce({ rows });
  }

  it("returns weeks oldest first, so direction is read rather than inferred", async () => {
    respond([]);
    await getAnswerQualityTrend(8);
    expect(String(mockQuery.mock.calls[0][0])).toMatch(/ORDER BY 1 ASC/);
  });

  /* Reviewed and changed are written on the same event precisely so "checked
     and fine" cannot be read as "not checked". Collapsing them here would
     undo that. */
  it("counts reviewed and corrected separately", async () => {
    respond([
      {
        week_start: "2026-08-24",
        model_calls: "900",
        flagged: "3",
        reviewed: "80",
        corrected: "12",
        irrelevant_retrievals: "7",
        not_promoted: "2",
      },
    ]);
    const t = await getAnswerQualityTrend(8);
    expect(t.weeks[0].reviewed).toBe(80);
    expect(t.weeks[0].corrected).toBe(12);
    expect(t.readable).toBe(true);
  });

  it("clamps the window instead of scanning the whole event table", async () => {
    respond([]);
    await getAnswerQualityTrend(9999);
    expect(mockQuery.mock.calls[0][1]).toEqual([52]);
  });

  it("refuses a window below one week", async () => {
    respond([]);
    await getAnswerQualityTrend(0);
    expect(mockQuery.mock.calls[0][1]).toEqual([1]);
  });
});

describe("when the trend cannot be read", () => {
  /* A report, not a control: it degrades rather than taking down the page it
     sits on. But it degrades OUT LOUD. Rendering zeros would report a clean
     week, which is exactly the week where nothing was being measured. */
  it("says it is unreadable rather than reporting a clean week", async () => {
    mockQuery.mockRejectedValue(new Error("db down"));
    const t = await getAnswerQualityTrend(8);
    expect(t.readable).toBe(false);
    expect(t.weeks).toEqual([]);
  });

  /* Empty and unreadable are different facts and must not collapse into one
     flag: one means nothing happened, the other means nobody looked. */
  it("keeps empty and unreadable as separate facts", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          week_start: "2026-08-24",
          model_calls: "0",
          flagged: "0",
          reviewed: "0",
          corrected: "0",
          irrelevant_retrievals: "0",
          not_promoted: "0",
        },
      ],
    });
    const t = await getAnswerQualityTrend(8);
    expect(t.readable).toBe(true);
    expect(t.empty).toBe(true);
  });
});
