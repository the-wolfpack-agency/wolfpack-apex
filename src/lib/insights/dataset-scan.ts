/**
 * Read a dataset and say what can honestly be claimed from it.
 *
 * WHAT THIS IS FOR. A client showed us a competitor's scan: headline figures,
 * a target beside each, and a paragraph recommending an 85 basis point rate
 * subvention and a $550 lease incentive. Confident, specific, and impossible
 * to check. Nothing said where a number came from, how many records it rested
 * on, how fresh they were, or what the scan could not see. "Trends are
 * worsening" appeared with no period and no magnitude.
 *
 * That is easy to beat, and not by being cleverer. A reader can only act on a
 * finding they can check, so every figure here carries the records under it,
 * and every claim the scan CANNOT support is stated rather than omitted.
 *
 * THE ONE THAT MATTERS MOST. Measured on the client's own evaluation exports:
 * 83 per cent of responses come from a single month. A trend claim over that
 * is not a weak finding, it is an unsupported one, and a scan that says so is
 * worth more than a scan that says "worsening". The competitor's example makes
 * exactly this claim about exactly this kind of data.
 *
 * COUNTS AND THEMES, NEVER PEOPLE. These records carry names, staff ids and
 * free text somebody wrote about their own workplace. Nothing here returns an
 * individual, for the same reason the gap panel does not: a report that
 * repeats what one person said stops being a report and starts being
 * surveillance, and the next cohort writes differently.
 */

/** One parsed response. Deliberately no name, no id. */
export interface DatasetRecord {
  /** Their job, which is the dimension worth cutting by. */
  role?: string;
  /** Month as YYYY-MM, when the record carries a date. */
  month?: string;
  /** Where the session ran, when the export records it. */
  venue?: string;
  /** The question asked. */
  prompt?: string;
  /** Length only. The words are read by the theme pass, never returned raw. */
  answerChars: number;
}

export interface Dimension {
  name: string;
  /** Values and how many records carry each, largest first. */
  values: { value: string; records: number }[];
  /**
   * How many records carry this dimension at all.
   *
   * The number the competitor's scan never shows. A breakdown by venue across
   * 1,506 records is a different claim when 5,714 were collected, and only one
   * of those two numbers appears on their page.
   */
  present: number;
  missing: number;
}

/** Something the scan will not assert, and why. */
export interface Withheld {
  claim: string;
  why: string;
}

export interface DatasetScan {
  records: number;
  documents: number;
  dimensions: Dimension[];
  /** Claims a reader would expect, that this data cannot carry. */
  withheld: Withheld[];
  /**
   * False when the dataset could not be read at all.
   *
   * A scan that failed and a dataset with nothing in it are the same empty
   * page and opposite facts.
   */
  readable: boolean;
}

/* A cut needs enough records to mean anything. Below this the difference
   between two values is noise wearing a percentage sign. */
export const MIN_RECORDS_PER_CUT = 30;

/* A dimension present on less than this share of records describes a subset,
   and a subset presented as the whole is the competitor's mistake. */
export const MIN_COVERAGE = 0.6;

/* A trend needs more than one period, and no single period may be so dominant
   that the comparison is really one month against a rounding error. */
export const MAX_SINGLE_PERIOD_SHARE = 0.7;

function tally(values: (string | undefined)[]): Dimension["values"] {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, records]) => ({ value, records }))
    .sort((a, b) => b.records - a.records || a.value.localeCompare(b.value));
}

function dimension(name: string, values: (string | undefined)[]): Dimension {
  const present = values.filter(Boolean).length;
  return { name, values: tally(values), present, missing: values.length - present };
}

/**
 * What the data supports, and what it does not.
 *
 * The withheld list is the product. Anyone can total a column; saying which
 * totals mean nothing is the part that makes the rest trustworthy.
 */
export function scanDataset(records: readonly DatasetRecord[], documents: number): DatasetScan {
  if (records.length === 0) {
    return { records: 0, documents, dimensions: [], withheld: [], readable: false };
  }

  const dims = [
    dimension("role", records.map((r) => r.role)),
    dimension("month", records.map((r) => r.month)),
    dimension("venue", records.map((r) => r.venue)),
    dimension("question", records.map((r) => r.prompt)),
  ];

  const withheld: Withheld[] = [];

  /* A dimension recorded on a minority of rows can still be reported, but not
     as though it described everyone. */
  for (const d of dims) {
    const coverage = d.present / records.length;
    if (d.present > 0 && coverage < MIN_COVERAGE) {
      withheld.push({
        claim: `Anything about ${d.name} across the whole dataset`,
        why:
          `${d.name} is recorded on ${d.present} of ${records.length} records ` +
          `(${Math.round(coverage * 100)}%). The breakdown below describes those records ` +
          `and not the rest, and nothing here treats it as the whole.`,
      });
    }
  }

  /* THE ONE THE COMPETITOR'S SCAN GETS WRONG. */
  const months = dims.find((d) => d.name === "month");
  if (months && months.values.length > 0) {
    const top = months.values[0];
    const share = top.records / months.present;
    if (months.values.length < 2) {
      withheld.push({
        claim: "Any trend over time",
        why: "Every record falls in one period, so there is nothing to compare it against.",
      });
    } else if (share > MAX_SINGLE_PERIOD_SHARE) {
      withheld.push({
        claim: "Any trend over time",
        why:
          `${Math.round(share * 100)}% of records fall in ${top.value}. A trend drawn across ` +
          `periods that uneven describes the sampling rather than the thing being measured.`,
      });
    }
  }

  /* Cuts too small to carry a comparison, named so nobody quotes them. */
  for (const d of dims) {
    const thin = d.values.filter((v) => v.records < MIN_RECORDS_PER_CUT);
    if (thin.length > 0 && thin.length < d.values.length) {
      withheld.push({
        claim: `Comparisons involving ${thin.length} of the ${d.values.length} ${d.name} values`,
        why:
          `They carry fewer than ${MIN_RECORDS_PER_CUT} records each ` +
          `(${thin.map((t) => `${t.value}: ${t.records}`).slice(0, 3).join(", ")}` +
          `${thin.length > 3 ? ", and others" : ""}). A difference between groups that small is noise.`,
      });
    }
  }

  return { records: records.length, documents, dimensions: dims, withheld, readable: true };
}

/**
 * Cuts a reader can rely on: enough records, and enough coverage.
 *
 * Exposed separately so a page can show the trustworthy breakdowns without a
 * reader having to cross-reference them against the withheld list.
 */
export function reliableCuts(scan: DatasetScan): Dimension[] {
  if (!scan.readable) return [];
  return scan.dimensions.filter(
    (d) =>
      d.present / scan.records >= MIN_COVERAGE &&
      d.values.some((v) => v.records >= MIN_RECORDS_PER_CUT),
  );
}
