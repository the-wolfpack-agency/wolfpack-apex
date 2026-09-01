/**
 * Results against plan, turned into things one team can actually do.
 *
 * WHAT THE CLIENT ASKED FOR, IN THEIR WORDS: "company facing, suggest ideas
 * for the C&I team to implement based on results vs sales/inventory plan." So
 * the output is not a metrics page. It is a short list of actions addressed to
 * one team, each tied to the gap it closes.
 *
 * WHAT THE COMPETITOR'S VERSION DOES INSTEAD. It recommends an 85 basis point
 * rate subvention and a $550 lease incentive because "trends are worsening".
 * A reader cannot tell which number drove which recommendation, how big the
 * gap is, how many records it rests on, or what would show it had worked. So
 * the only available responses are to accept the whole page or reject it, and
 * a C&I lead who cannot argue with one line will not act on any of them.
 *
 * THE FOUR THINGS EVERY RECOMMENDATION HERE CARRIES.
 *
 *   The gap, as a number, against the plan it missed.
 *   The evidence, as a record count, so a thin one is visibly thin.
 *   What would show it worked, before anybody starts.
 *   What would make it wrong, so it can be argued with.
 *
 * AND THE ONE THAT MATTERS MOST: IT REFUSES. If the scan would not claim
 * something, nothing here recommends acting on it. A dimension recorded on 16
 * per cent of records produces no action, and says so, because a
 * recommendation built on a claim we already declined to make is the
 * competitor's mistake wearing our name.
 */

import type { DatasetScan, Dimension } from "./dataset-scan";
import { MIN_RECORDS_PER_CUT } from "./dataset-scan";

/** A number the business expected, against the dimension it applies to. */
export interface PlanTarget {
  /** Which dimension this is a plan for, e.g. "role" or "model". */
  dimension: string;
  /** Which value within it, e.g. "Sales Professional" or "Cayenne". */
  value: string;
  /** What was planned. */
  planned: number;
  /** What a reader calls this number. */
  unit: string;
}

/** How much a target missed, and how much evidence sits under it. */
export interface Gap {
  dimension: string;
  value: string;
  planned: number;
  actual: number;
  /** Negative is a shortfall. */
  variance: number;
  /** Share of plan, so gaps of different sizes can be ranked together. */
  variancePct: number;
  records: number;
}

export type Confidence = "strong" | "limited" | "insufficient";

export interface Recommendation {
  /** Addressed to a team, phrased as something to do. */
  action: string;
  gap: Gap;
  confidence: Confidence;
  /** Why the confidence is what it is, in records rather than adjectives. */
  basis: string;
  /** Agreed before anybody starts, or it cannot be judged afterwards. */
  successSignal: string;
  /** The fact that would make this the wrong move. */
  wouldBeWrongIf: string;
}

/** Something the data will not support acting on, and why. */
export interface NoAction {
  about: string;
  why: string;
}

export interface Advice {
  recommendations: Recommendation[];
  /** Gaps that are real but cannot yet carry an action. */
  notActionable: NoAction[];
  /** False when the dataset could not be read. */
  readable: boolean;
}

/** Under this share of plan a miss is inside normal variation, not a gap. */
export const MATERIAL_VARIANCE = 0.05;

/** Records needed before a gap justifies spending money on it. */
export const STRONG_EVIDENCE = 100;

function confidenceFor(records: number): Confidence {
  if (records >= STRONG_EVIDENCE) return "strong";
  if (records >= MIN_RECORDS_PER_CUT) return "limited";
  return "insufficient";
}

/** Measure each target against what the scan actually counted. */
export function measureGaps(scan: DatasetScan, targets: readonly PlanTarget[]): Gap[] {
  const byName = new Map<string, Dimension>(scan.dimensions.map((d) => [d.name, d]));
  const gaps: Gap[] = [];

  for (const t of targets) {
    const dim = byName.get(t.dimension);
    if (!dim) continue;
    const hit = dim.values.find((v) => v.value === t.value);
    const actual = hit?.records ?? 0;
    const variance = actual - t.planned;
    gaps.push({
      dimension: t.dimension,
      value: t.value,
      planned: t.planned,
      actual,
      variance,
      variancePct: t.planned === 0 ? 0 : variance / t.planned,
      records: actual,
    });
  }

  /* Worst shortfall first. A team reads three lines, so the order is the
     product as much as the content is. */
  return gaps.sort((a, b) => a.variancePct - b.variancePct);
}

/**
 * Turn gaps into actions, and refuse the ones the data cannot carry.
 *
 * `team` is named in every action because an unaddressed recommendation is
 * one everybody assumes somebody else owns.
 */
export function recommend(
  scan: DatasetScan,
  targets: readonly PlanTarget[],
  team: string,
): Advice {
  if (!scan.readable) return { recommendations: [], notActionable: [], readable: false };

  const gaps = measureGaps(scan, targets);
  const recommendations: Recommendation[] = [];
  const notActionable: NoAction[] = [];

  /* Dimensions the scan declined to describe AT ALL. Acting on one would be
     acting on a claim we refused to make two steps earlier.
     
     Only "whole" withholdings count. A note that two of nine roles are too
     thin to compare says nothing about the other seven, and treating it as a
     veto on the dimension would silence the best-evidenced cut in the
     dataset. Thin values are caught below, per value, where they belong. */
  const withheldDims = new Set(
    scan.withheld
      .filter((w) => w.scope === "whole" && w.dimension)
      .map((w) => w.dimension as string),
  );

  for (const gap of gaps) {
    if (withheldDims.has(gap.dimension)) {
      notActionable.push({
        about: `${gap.value} (${gap.dimension})`,
        why:
          `The scan will not describe ${gap.dimension} across this dataset, so a plan variance ` +
          `measured against it would be a variance against a subset of unknown shape.`,
      });
      continue;
    }

    if (Math.abs(gap.variancePct) < MATERIAL_VARIANCE) continue;

    const confidence = confidenceFor(gap.records);
    if (confidence === "insufficient") {
      notActionable.push({
        about: `${gap.value} (${gap.dimension})`,
        why:
          `${gap.records} records. A ${Math.round(Math.abs(gap.variancePct) * 100)}% variance on ` +
          `that few is as likely to be who happened to respond as it is a real shortfall.`,
      });
      continue;
    }

    const short = gap.variance < 0;
    const size = Math.abs(gap.variance);
    const pct = Math.round(Math.abs(gap.variancePct) * 100);

    recommendations.push({
      action: short
        ? `${team}: close the ${pct}% shortfall on ${gap.value} (${size} under plan).`
        : `${team}: ${gap.value} is ${pct}% over plan (${size} above). Decide whether to hold the plan or move it.`,
      gap,
      confidence,
      basis:
        confidence === "strong"
          ? `${gap.records} records, above the ${STRONG_EVIDENCE} this treats as enough to spend against.`
          : `${gap.records} records. Enough to raise, not enough to commit budget to without a second period.`,
      successSignal: short
        ? `${gap.value} reaches ${gap.planned} ${targets.find((t) => t.value === gap.value)?.unit ?? "units"} in the next measured period, from ${gap.actual} now.`
        : `The plan is restated at a number the last two periods support, or the surplus holds for a second period.`,
      wouldBeWrongIf:
        `The ${gap.records} records behind ${gap.value} are not representative of the period, ` +
        `or the plan of ${gap.planned} was set against a different definition of ${gap.dimension}.`,
    });
  }

  return { recommendations, notActionable, readable: true };
}

/**
 * The sentence to put above the list.
 *
 * Written so a reader knows the shape of what follows before reading any of
 * it, including how much was refused. A page that shows three actions and
 * hides four refusals is describing a cleaner dataset than the one it read.
 */
export function summarize(advice: Advice, scan: DatasetScan): string {
  if (!advice.readable) {
    return "This dataset could not be read, which is not the same as it having nothing in it.";
  }
  const strong = advice.recommendations.filter((r) => r.confidence === "strong").length;
  const parts = [
    `${advice.recommendations.length} action${advice.recommendations.length === 1 ? "" : "s"} from ${scan.records.toLocaleString()} records`,
    strong > 0 ? `${strong} on evidence strong enough to spend against` : null,
    advice.notActionable.length > 0
      ? `${advice.notActionable.length} gap${advice.notActionable.length === 1 ? "" : "s"} left unactioned, each with the reason`
      : null,
  ].filter(Boolean);
  return `${parts.join(", ")}.`;
}
