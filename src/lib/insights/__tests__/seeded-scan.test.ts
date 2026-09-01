/**
 * Grade the scan against datasets whose right answer we chose in advance.
 *
 * WHY THIS EXISTS. We have one real corpus. An engine tested only against it
 * is tuned to it, and nothing says whether it would judge a different client's
 * numbers sensibly. A seeded dataset has properties we picked, so "did the
 * scan reach the right verdict" stops being an opinion and becomes a test.
 *
 * Same move as the retrieval eval set: constructing from a known ground truth
 * beats harvesting whatever we happen to have, because the harvest has no
 * answer key.
 *
 * These four specs are that key. A scan that gets one wrong is wrong about any
 * real dataset with the same shape, and the shape of oneMonthDominates is the
 * shape of both the client's exports and the competitor's slide.
 */

import { scanDataset, reliableCuts } from "@/lib/insights/dataset-scan";
import { seedDataset, assertSingleProvenance, SPECS } from "@/lib/insights/seed-dataset";

const scanOf = (spec: keyof typeof SPECS, seed = 1) =>
  scanDataset(seedDataset(SPECS[spec], seed), 1);

const withheldAbout = (s: ReturnType<typeof scanDataset>, rx: RegExp) =>
  s.withheld.filter((w) => rx.test(w.claim));

describe("the scan, graded against a known answer", () => {
  it("reads a trend when the periods are even and the volume is there", () => {
    expect(withheldAbout(scanOf("supportsATrend"), /trend/i)).toHaveLength(0);
  });

  /* THE CLIENT'S OWN SHAPE, AND THE COMPETITOR'S. Their slide asserted
     "trends are worsening" over data like this. */
  it("refuses a trend when one period carries most of the records", () => {
    const w = withheldAbout(scanOf("oneMonthDominates"), /trend/i);
    expect(w).toHaveLength(1);
    expect(w[0].why).toMatch(/sampling/i);
  });

  it("refuses to treat a thinly recorded dimension as the whole", () => {
    const s = scanOf("thinVenueCoverage");
    expect(withheldAbout(s, /venue/i)).toHaveLength(1);
    expect(reliableCuts(s).map((d) => d.name)).not.toContain("venue");
  });

  it("names a group too small to compare, and keeps the one that is not", () => {
    const s = scanOf("aGroupTooSmallToCompare");
    const w = withheldAbout(s, /Comparisons involving/i);
    expect(w).toHaveLength(1);
    expect(w[0].why).toMatch(/General Manager/);
    expect(reliableCuts(s).map((d) => d.name)).toContain("role");
  });

  /* A verdict that changes with the seed is a verdict about the seed. */
  it("reaches the same verdict whatever the seed", () => {
    for (const seed of [1, 7, 99, 4242]) {
      expect(withheldAbout(scanOf("oneMonthDominates", seed), /trend/i)).toHaveLength(1);
      expect(withheldAbout(scanOf("supportsATrend", seed), /trend/i)).toHaveLength(0);
    }
  });

  it("builds what the spec asked for", () => {
    const records = seedDataset(SPECS.oneMonthDominates);
    const aug = records.filter((r) => r.month === "2026-08").length;
    /* 85 per cent, within the slack a 400-record draw allows. */
    expect(aug / records.length).toBeGreaterThan(0.78);
    expect(aug / records.length).toBeLessThan(0.92);
  });

  it("is reproducible, so a failure can be looked at twice", () => {
    expect(seedDataset(SPECS.supportsATrend, 5)).toEqual(seedDataset(SPECS.supportsATrend, 5));
    expect(seedDataset(SPECS.supportsATrend, 5)).not.toEqual(seedDataset(SPECS.supportsATrend, 6));
  });
});

describe("seeded and measured never mix", () => {
  /* THE RISK THAT MAKES SEEDING WORTH DOING CAREFULLY. A demo insight that
     looks exactly like a client insight will eventually be screenshotted as
     one. Provenance is a required field rather than a convention. */
  it("marks every generated record as seeded", () => {
    for (const r of seedDataset(SPECS.supportsATrend)) expect(r.provenance).toBe("seeded");
  });

  it("refuses a dataset drawn from both", () => {
    const mixed = [
      ...seedDataset({ ...SPECS.supportsATrend, records: 5 }),
      { provenance: "real" as const, role: "Sales Professional", answerChars: 0 },
    ];
    /* Thrown rather than filtered: silently dropping half a dataset is the
       quieter version of the same lie. */
    expect(() => assertSingleProvenance(mixed)).toThrow(/true of neither/i);
  });

  it("reports the provenance of a clean dataset", () => {
    expect(assertSingleProvenance(seedDataset(SPECS.supportsATrend))).toBe("seeded");
    expect(assertSingleProvenance([])).toBeNull();
  });
});

describe("volume, which is how the system gets sized", () => {
  /* The pilot dashboard read 2.6 million rows to report six thousand, and
     nobody found it until a page took twenty seconds in front of the person
     paying for it. Generated volume finds that on a Tuesday. */
  it("scans a hundred thousand records without falling over", () => {
    const big = seedDataset({ ...SPECS.supportsATrend, records: 100_000 });
    const started = Date.now();
    const s = scanDataset(big, 1);
    expect(s.records).toBe(100_000);
    expect(s.readable).toBe(true);
    /* Generous on purpose: this is a smoke test for quadratic behavior, not a
       benchmark to tune against. A regression that matters will blow it by an
       order of magnitude, not by a hair. */
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
