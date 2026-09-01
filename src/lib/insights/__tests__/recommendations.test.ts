/**
 * Actions for one team, and the ones this refuses to suggest.
 *
 * WHAT IT IS MEASURED AGAINST. The competitor's scan recommends an 85 basis
 * point rate subvention and a $550 lease incentive because "trends are
 * worsening". A reader cannot tell which number drove which recommendation,
 * how big the gap is, what it rests on, or what would show it had worked, so
 * the only responses available are to accept the whole page or reject it.
 *
 * Every test here is a line that page would have printed, and the reason ours
 * does not.
 */

import { scanDataset, type DatasetRecord } from "@/lib/insights/dataset-scan";
import {
  recommend,
  measureGaps,
  summarize,
  MATERIAL_VARIANCE,
  STRONG_EVIDENCE,
  type PlanTarget,
} from "@/lib/insights/recommendations";

const rec = (over: Partial<DatasetRecord> = {}): DatasetRecord => ({ answerChars: 0, ...over });
const many = (n: number, over: Partial<DatasetRecord> = {}) => Array.from({ length: n }, () => rec(over));
const plan = (value: string, planned: number, dimension = "role"): PlanTarget => ({
  dimension,
  value,
  planned,
  unit: "responses",
});

describe("what this refuses to recommend", () => {
  /* THE ONE THE COMPETITOR GETS WRONG. Venue is recorded on 16 per cent of the
     client's real records. Their page would report a variance against it and
     recommend acting on it. */
  it("will not act on a dimension the scan declined to describe", () => {
    const records = [...many(20, { role: "Sales", venue: "Ritz Carlton" }), ...many(180, { role: "Sales" })];
    const scan = scanDataset(records, 1);
    const advice = recommend(scan, [plan("Ritz Carlton", 100, "venue")], "C&I");

    expect(advice.recommendations).toHaveLength(0);
    expect(advice.notActionable[0].why).toMatch(/subset of unknown shape/i);
  });

  /* A 40 per cent variance on nine records is who happened to reply, not a
     shortfall, and it is exactly the kind of line that ends up justifying a
     rate change. */
  it("will not act on a gap with too little behind it", () => {
    const scan = scanDataset([...many(400, { role: "Sales" }), ...many(9, { role: "GM" })], 1);
    const advice = recommend(scan, [plan("GM", 20)], "C&I");

    expect(advice.recommendations).toHaveLength(0);
    expect(advice.notActionable[0].why).toMatch(/who happened to respond/i);
    expect(advice.notActionable[0].why).toMatch(/9 records/);
  });

  it("says nothing about a miss inside normal variation", () => {
    const scan = scanDataset(many(200, { role: "Sales" }), 1);
    /* 2 per cent under, below the material threshold. */
    const advice = recommend(scan, [plan("Sales", 204)], "C&I");
    expect(advice.recommendations).toHaveLength(0);
    expect(advice.notActionable).toHaveLength(0);
  });

  it("reports that it could not read the data, rather than having no advice", () => {
    const advice = recommend(scanDataset([], 0), [plan("Sales", 100)], "C&I");
    expect(advice.readable).toBe(false);
    expect(summarize(advice, scanDataset([], 0))).toMatch(/not the same as/i);
  });
});

describe("what a recommendation has to carry", () => {
  const scan = scanDataset([...many(205, { role: "GM" }), ...many(1608, { role: "Sales" })], 1);
  const advice = recommend(scan, [plan("GM", 400), plan("Sales", 1200)], "C&I");

  it("names the team, so nobody assumes somebody else owns it", () => {
    for (const r of advice.recommendations) expect(r.action).toMatch(/^C&I:/);
  });

  it("states the gap as a number against the plan it missed", () => {
    const gm = advice.recommendations.find((r) => r.gap.value === "GM")!;
    expect(gm.gap.planned).toBe(400);
    expect(gm.gap.actual).toBe(205);
    expect(gm.gap.variance).toBe(-195);
    expect(gm.action).toMatch(/49% shortfall/);
    expect(gm.action).toMatch(/195 under plan/);
  });

  /* Confidence in records rather than adjectives, so a reader can disagree
     with the threshold instead of with the vibe. */
  it("ties confidence to how much evidence there is", () => {
    for (const r of advice.recommendations) {
      expect(r.confidence).toBe("strong");
      expect(r.basis).toMatch(new RegExp(`${r.gap.records}`));
      expect(r.basis).toMatch(new RegExp(`${STRONG_EVIDENCE}`));
    }
  });

  /* AGREED BEFORE ANYBODY STARTS, or it cannot be judged afterwards. This is
     the field the competitor's page has no equivalent of. */
  it("says what would show it worked", () => {
    const gm = advice.recommendations.find((r) => r.gap.value === "GM")!;
    expect(gm.successSignal).toMatch(/reaches 400 responses/);
    expect(gm.successSignal).toMatch(/from 205 now/);
  });

  /* A recommendation nobody can argue with is one nobody can act on either. */
  it("says what would make it wrong", () => {
    for (const r of advice.recommendations) {
      expect(r.wouldBeWrongIf.length).toBeGreaterThan(40);
      expect(r.wouldBeWrongIf).toMatch(/not representative|different definition/i);
    }
  });

  it("puts the worst shortfall first, because a team reads three lines", () => {
    expect(advice.recommendations[0].gap.value).toBe("GM");
  });

  it("distinguishes over plan from under plan", () => {
    const over = advice.recommendations.find((r) => r.gap.value === "Sales")!;
    expect(over.action).toMatch(/over plan/);
    expect(over.action).toMatch(/hold the plan or move it/);
  });
});

describe("the line above the list", () => {
  /* A page showing three actions and hiding four refusals describes a cleaner
     dataset than the one it read. */
  it("counts the refusals alongside the advice", () => {
    const scan = scanDataset([...many(400, { role: "Sales" }), ...many(9, { role: "GM" })], 1);
    const advice = recommend(scan, [plan("GM", 40), plan("Sales", 200)], "C&I");
    const line = summarize(advice, scan);
    expect(line).toMatch(/409 records/);
    expect(line).toMatch(/1 gap left unactioned/);
  });
});

describe("measuring against plan", () => {
  it("counts a value the data never saw as zero rather than skipping it", () => {
    const scan = scanDataset(many(50, { role: "Sales" }), 1);
    const gaps = measureGaps(scan, [plan("Parts Manager", 100)]);
    /* Absent from the data is a 100 per cent shortfall, not a missing row.
       Dropping it would let a plan target vanish silently. */
    expect(gaps[0]).toMatchObject({ actual: 0, variance: -100, variancePct: -1 });
  });

  it("ignores a target for a dimension the dataset does not have", () => {
    const scan = scanDataset(many(50, { role: "Sales" }), 1);
    expect(measureGaps(scan, [plan("Cayenne", 10, "model")])).toHaveLength(0);
  });

  it("keeps the material-variance bar visible", () => {
    expect(MATERIAL_VARIANCE).toBeGreaterThan(0);
    expect(MATERIAL_VARIANCE).toBeLessThan(0.2);
  });
});
