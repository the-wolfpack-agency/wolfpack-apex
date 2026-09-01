/**
 * Datasets with a known answer, so the scan can be graded rather than trusted.
 *
 * WHY SEEDING IS WORTH BUILDING. We have one real corpus. An insight engine
 * tested against one dataset is tuned to that dataset, and nothing tells us
 * whether it would say something sensible about a different client's numbers.
 * Seeding fixes the thing that actually blocks confidence: a generated dataset
 * has properties we CHOSE, so "did the scan reach the right verdict" becomes a
 * test instead of an opinion.
 *
 * That is the same move as the retrieval eval set. Harvesting from what we
 * happen to have gives pairs nobody can grade; constructing from a known
 * ground truth gives an answer key.
 *
 * IT IS ALSO HOW THE SYSTEM GETS SIZED. The pilot dashboard was reading 2.6
 * million rows to report six thousand, and nobody found it until a page took
 * twenty seconds in front of the person paying for it. Generated volume is how
 * that gets found at ten and a hundred times the current size, on a Tuesday,
 * instead of in a demo.
 *
 * THE CONSTRAINT THAT MAKES THIS SAFE, AND IT IS NOT OPTIONAL. Seeded records
 * and real ones must never be spellable the same way. A demo insight that
 * looks exactly like a client insight will eventually be screenshotted as one,
 * and the whole argument of this scan is that a figure carries its evidence.
 * So provenance is a required field rather than a convention, the scan refuses
 * to mix the two in one finding, and a mixed dataset is an error rather than a
 * silent average.
 */

import type { DatasetRecord } from "./dataset-scan";

/** Where a record came from. Required, because a default would be guessable. */
export type Provenance = "real" | "seeded";

export interface SeededRecord extends DatasetRecord {
  provenance: Provenance;
}

/**
 * What a seeded dataset is supposed to contain.
 *
 * The scan's verdict is checked against this, so the shape has to describe
 * exactly the things the scan makes judgments about and nothing else.
 */
export interface SeedSpec {
  /** How many records. Turn this up to size the system. */
  records: number;
  /** Periods and their share. Two even periods support a trend; one does not. */
  periods: { month: string; share: number }[];
  /** Values for the role dimension and their share. */
  roles: { value: string; share: number }[];
  /** What fraction of records carry a venue at all. */
  venueCoverage: number;
}

/**
 * A fixed, seeded pseudo-random sequence.
 *
 * Math.random would make a failing test unreproducible, which is the one thing
 * a dataset used as an answer key cannot be. The constants are the common
 * 32-bit LCG pair; nothing here needs cryptographic quality, only repeatability.
 */
function sequence(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Pick by share, so a spec that says 80/20 produces 80/20. */
function pick<T extends { share: number }>(items: readonly T[], r: number): T {
  let acc = 0;
  for (const it of items) {
    acc += it.share;
    if (r < acc) return it;
  }
  return items[items.length - 1];
}

const VENUES = ["Ritz Carlton", "Conrad", "Westlake", "Intercontinental"];

/**
 * Build a dataset that matches the spec.
 *
 * Every record is marked seeded. There is no option to mark them otherwise,
 * because the only reason to want one would be to pass seeded numbers off as
 * measured ones.
 */
export function seedDataset(spec: SeedSpec, seed = 1): SeededRecord[] {
  const next = sequence(seed);
  const out: SeededRecord[] = [];
  for (let i = 0; i < spec.records; i++) {
    const venue = next() < spec.venueCoverage ? VENUES[i % VENUES.length] : undefined;
    out.push({
      provenance: "seeded",
      role: pick(spec.roles, next()).value,
      month: pick(spec.periods, next()).month,
      ...(venue ? { venue } : {}),
      answerChars: 0,
    });
  }
  return out;
}

/**
 * Refuse a dataset that mixes measured and generated records.
 *
 * Averaging the two produces a number that is true of neither, and the reader
 * has no way to see it happened. Thrown rather than filtered, because silently
 * dropping half a dataset is the quieter version of the same lie.
 */
export function assertSingleProvenance(records: readonly SeededRecord[]): Provenance | null {
  if (records.length === 0) return null;
  const kinds = new Set(records.map((r) => r.provenance));
  if (kinds.size > 1) {
    throw new Error(
      "dataset mixes real and seeded records: a finding drawn across both is true of neither",
    );
  }
  return [...kinds][0];
}

/**
 * Ready-made specs, each named for the verdict it should produce.
 *
 * These are the answer key. A scan that gets one of these wrong is wrong about
 * a real dataset with the same shape, which is the whole point of having them.
 */
export const SPECS: Record<string, SeedSpec> = {
  /* Two even periods and plenty of volume: a trend is supportable. */
  supportsATrend: {
    records: 400,
    periods: [
      { month: "2026-07", share: 0.5 },
      { month: "2026-08", share: 0.5 },
    ],
    roles: [
      { value: "Sales Professional", share: 0.5 },
      { value: "Service Consultant", share: 0.5 },
    ],
    venueCoverage: 1,
  },
  /* The shape of the client's own exports, and of the competitor's slide. */
  oneMonthDominates: {
    records: 400,
    periods: [
      { month: "2026-07", share: 0.15 },
      { month: "2026-08", share: 0.85 },
    ],
    roles: [
      { value: "Sales Professional", share: 0.6 },
      { value: "Service Consultant", share: 0.4 },
    ],
    venueCoverage: 1,
  },
  /* A dimension that describes a corner of the data. */
  thinVenueCoverage: {
    records: 400,
    periods: [
      { month: "2026-07", share: 0.5 },
      { month: "2026-08", share: 0.5 },
    ],
    roles: [{ value: "Sales Professional", share: 1 }],
    venueCoverage: 0.2,
  },
  /* One group large enough to talk about, one nowhere near it. */
  aGroupTooSmallToCompare: {
    records: 400,
    periods: [
      { month: "2026-07", share: 0.5 },
      { month: "2026-08", share: 0.5 },
    ],
    roles: [
      { value: "Sales Professional", share: 0.97 },
      { value: "General Manager", share: 0.03 },
    ],
    venueCoverage: 1,
  },
};
