/**
 * The claims a scan refuses to make.
 *
 * WHAT THIS IS MEASURED AGAINST. A competitor's scan, shown to the client,
 * which reported headline figures beside targets and then recommended an 85
 * basis point rate subvention and a $550 lease incentive because "trends are
 * worsening". No period, no magnitude, no record count, nothing about what the
 * scan could not see.
 *
 * Every test here is one of the ways that page would have been wrong on the
 * client's own data, and the assertions are the reasons ours does not say it.
 */

import {
  scanDataset,
  reliableCuts,
  MIN_RECORDS_PER_CUT,
  MIN_COVERAGE,
  MAX_SINGLE_PERIOD_SHARE,
  type DatasetRecord,
} from "@/lib/insights/dataset-scan";

const rec = (over: Partial<DatasetRecord> = {}): DatasetRecord => ({ answerChars: 0, ...over });
const many = (n: number, over: Partial<DatasetRecord> = {}) => Array.from({ length: n }, () => rec(over));

describe("what the scan refuses to claim", () => {
  /* THE COMPETITOR'S EXACT MISTAKE, ON THE CLIENT'S EXACT DATA. Measured on
     the real evaluation exports, 79 per cent of responses fall in one month.
     A trend over that describes when the survey was run, not what it found. */
  it("will not read a trend when one period dominates", () => {
    const s = scanDataset([...many(90, { month: "2026-08" }), ...many(10, { month: "2026-07" })], 1);
    const trend = s.withheld.find((w) => /trend/i.test(w.claim));
    expect(trend).toBeDefined();
    expect(trend!.why).toMatch(/90%/);
  });

  it("will not read a trend from a single period", () => {
    const s = scanDataset(many(500, { month: "2026-08" }), 1);
    expect(s.withheld.find((w) => /trend/i.test(w.claim))?.why).toMatch(/nothing to compare/i);
  });

  /* Periods that are actually comparable produce no objection, or the rule
     would be a mute button on every dataset. */
  it("allows a trend across balanced periods", () => {
    const s = scanDataset(
      [...many(50, { month: "2026-07" }), ...many(50, { month: "2026-08" })],
      1,
    );
    expect(s.withheld.find((w) => /trend/i.test(w.claim))).toBeUndefined();
  });

  /* THE NUMBER THEIR PAGE NEVER SHOWS. A venue breakdown over 826 records
     reads as the whole picture when 5,257 were collected, and only one of
     those numbers was on their slide. */
  it("says when a dimension covers only part of the data", () => {
    const s = scanDataset([...many(20, { venue: "Ritz Carlton" }), ...many(80)], 1);
    const w = s.withheld.find((x) => /venue/i.test(x.claim));
    expect(w).toBeDefined();
    expect(w!.why).toMatch(/20 of 100/);
    expect(w!.why).toMatch(/20%/);
  });

  it("does not complain about a dimension recorded on nearly everything", () => {
    const s = scanDataset(many(100, { role: "Sales" }), 1);
    expect(s.withheld.find((x) => /role/i.test(x.claim))).toBeUndefined();
  });

  /* A difference between two groups of nine is noise with a percentage sign
     on it, which is how a scan ends up recommending a rate change. */
  it("names the cuts too small to compare", () => {
    const s = scanDataset(
      [...many(200, { role: "Sales Professional" }), ...many(5, { role: "General Manager" })],
      1,
    );
    const w = s.withheld.find((x) => /role/i.test(x.claim) && /Comparisons/i.test(x.claim));
    expect(w).toBeDefined();
    expect(w!.why).toMatch(/General Manager: 5/);
  });

  it("does not flag thin cuts when every cut is thin", () => {
    /* Nothing to compare against, so the warning would be about the whole
       dataset rather than about a few values, and the coverage rules already
       carry that. */
    const s = scanDataset([...many(5, { role: "A" }), ...many(4, { role: "B" })], 1);
    expect(s.withheld.find((x) => /Comparisons involving/i.test(x.claim))).toBeUndefined();
  });
});

describe("what the scan will stand behind", () => {
  it("offers only cuts with the coverage and the volume to hold up", () => {
    const s = scanDataset(
      [
        ...many(60, { role: "Sales Professional", venue: "Ritz Carlton" }),
        ...many(60, { role: "Service Consultant" }),
      ],
      2,
    );
    const names = reliableCuts(s).map((d) => d.name);
    expect(names).toContain("role");
    /* Venue is on half the records, under the coverage bar. */
    expect(names).not.toContain("venue");
  });

  it("ranks each dimension's values by how much evidence each has", () => {
    const s = scanDataset([...many(10, { role: "B" }), ...many(40, { role: "A" })], 1);
    const role = s.dimensions.find((d) => d.name === "role")!;
    expect(role.values[0]).toEqual({ value: "A", records: 40 });
    expect(role.missing).toBe(0);
  });

  /* AN UNREADABLE DATASET AND AN EMPTY ONE ARE THE SAME EMPTY PAGE AND
     OPPOSITE FACTS. */
  it("says it could not read anything rather than reporting nothing found", () => {
    const s = scanDataset([], 0);
    expect(s.readable).toBe(false);
    expect(reliableCuts(s)).toEqual([]);
  });

  it("keeps the thresholds it judges by visible", () => {
    /* A reader who disagrees with a verdict should be able to see the bar it
       was measured against rather than guess at it. */
    expect(MIN_RECORDS_PER_CUT).toBeGreaterThan(1);
    expect(MIN_COVERAGE).toBeGreaterThan(0.5);
    expect(MAX_SINGLE_PERIOD_SHARE).toBeLessThan(1);
  });
});

describe("what never leaves the scan", () => {
  /* These records carry names, staff ids and free text somebody wrote about
     their own workplace. A report that quotes one person stops being a report,
     and the next cohort writes differently. */
  it("returns counts and never a person", () => {
    const s = scanDataset(many(50, { role: "Sales Professional" }), 1);
    const serialized = JSON.stringify(s);
    expect(serialized).not.toMatch(/answerChars/);
    for (const d of s.dimensions) {
      for (const v of d.values) expect(typeof v.records).toBe("number");
    }
  });
});
