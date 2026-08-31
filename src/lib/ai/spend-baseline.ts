/**
 * What AI cost before the router, and what it costs now.
 *
 * WHY THIS IS RECORDED RATHER THAN DERIVED
 *
 * The router already knows what every call cost and what the same call would
 * have cost at the tier the call site used to send unconditionally. That
 * answers "is the router cheaper than not routing", which compares two ways of
 * using the router.
 *
 * The question somebody actually asks is "I was paying X a month before any of
 * this existed, what am I paying now". Nothing in this system knows X, because
 * X is an invoice from a vendor. It has to be typed in.
 *
 * THE COMPARISON IS NOT AUTOMATICALLY FLATTERING, AND MUST NOT PRETEND TO BE
 *
 * A flat monthly subscription and metered per-call spend are different shapes.
 * A subscription costs the same whether it was used once or a thousand times,
 * so heavy use under a subscription can be cheaper than the same work metered,
 * and light use can be far dearer. Presenting the difference as a saving with
 * no note about what each side IS would be the kind of number that wins an
 * argument once and loses all credibility the first time somebody checks it.
 *
 * So every figure carries its kind and its note, and the comparison reports the
 * two amounts alongside each other with what each covers. The subtraction is
 * offered, never asserted.
 */

/** USD cents, so two reports of the same figure cannot disagree by rounding. */
export type Cents = number;

export interface BaselineRow {
  /** First day of the month the amount covers, as YYYY-MM-DD. */
  periodMonth: string;
  amountCents: Cents;
  /** An invoice is a fact. A recurring rate is an assumption that has been
   *  written down, and the difference has to survive to the page. */
  kind: "invoiced" | "recurring_estimate";
  note: string | null;
}

export interface MonthComparison {
  periodMonth: string;
  /** What was paid before the router, when a figure was recorded for it. */
  baselineCents: Cents | null;
  baselineKind: BaselineRow["kind"] | null;
  baselineNote: string | null;
  /** What the router actually spent that month, from the provider's own
   *  billed figures. Zero is a real answer; null means nothing was recorded. */
  measuredCents: Cents | null;
  /** baseline minus measured, when BOTH exist. Null otherwise, deliberately:
   *  a difference computed against a missing side is a number made up. */
  differenceCents: Cents | null;
}

export function toCents(usd: number): Cents {
  return Math.round(usd * 100);
}

export function formatUsd(cents: Cents | null): string {
  if (cents === null) return "not recorded";
  return `$${(cents / 100).toFixed(2)}`;
}

/** First day of the month containing a date, as YYYY-MM-DD. */
export function monthKey(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

/**
 * Join recorded baselines to measured spend.
 *
 * Pure, so the arithmetic can be read without a database. Months present on
 * either side appear in the result: a month with a baseline and no measured
 * spend is the interesting one (the router was not in use yet), and dropping
 * it would quietly shorten the history that makes the comparison worth making.
 */
export function compareMonths(
  baselines: BaselineRow[],
  measured: Array<{ periodMonth: string; cents: Cents }>,
): MonthComparison[] {
  const byMonth = new Map<string, MonthComparison>();

  const ensure = (m: string): MonthComparison => {
    let row = byMonth.get(m);
    if (!row) {
      row = {
        periodMonth: m,
        baselineCents: null,
        baselineKind: null,
        baselineNote: null,
        measuredCents: null,
        differenceCents: null,
      };
      byMonth.set(m, row);
    }
    return row;
  };

  for (const b of baselines) {
    const row = ensure(b.periodMonth);
    row.baselineCents = b.amountCents;
    row.baselineKind = b.kind;
    row.baselineNote = b.note;
  }
  for (const m of measured) {
    ensure(m.periodMonth).measuredCents = m.cents;
  }

  for (const row of byMonth.values()) {
    /* Both sides or nothing. A difference against a missing side is not a
       small inaccuracy, it is a number somebody would quote. */
    row.differenceCents =
      row.baselineCents !== null && row.measuredCents !== null
        ? row.baselineCents - row.measuredCents
        : null;
  }

  return [...byMonth.values()].sort((a, b) => a.periodMonth.localeCompare(b.periodMonth));
}

export interface BaselineSummary {
  months: MonthComparison[];
  /** Months where both sides are known. The only rows a total may use. */
  comparableMonths: number;
  totalBaselineCents: Cents;
  totalMeasuredCents: Cents;
  totalDifferenceCents: Cents;
  /** True when at least one comparable month rests on an assumed rate rather
   *  than an invoice, so the page can say so instead of implying otherwise. */
  includesEstimate: boolean;
}

export function summarize(months: MonthComparison[]): BaselineSummary {
  const comparable = months.filter((m) => m.differenceCents !== null);
  return {
    months,
    comparableMonths: comparable.length,
    totalBaselineCents: comparable.reduce((s, m) => s + (m.baselineCents ?? 0), 0),
    totalMeasuredCents: comparable.reduce((s, m) => s + (m.measuredCents ?? 0), 0),
    totalDifferenceCents: comparable.reduce((s, m) => s + (m.differenceCents ?? 0), 0),
    includesEstimate: comparable.some((m) => m.baselineKind === "recurring_estimate"),
  };
}
