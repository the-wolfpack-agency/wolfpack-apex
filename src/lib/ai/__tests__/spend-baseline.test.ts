/**
 * The before-and-after arithmetic.
 *
 * This produces a number somebody will say out loud to justify a decision, so
 * the tests are mostly about REFUSING to produce one: no difference against a
 * missing side, no total that mixes comparable and incomparable months, and no
 * quiet promotion of an assumed monthly rate into something that reads like an
 * invoice.
 */
import {
  compareMonths,
  summarize,
  toCents,
  formatUsd,
  monthKey,
  type BaselineRow,
} from "../spend-baseline";

const invoiced = (m: string, usd: number, note = "Claude, monthly"): BaselineRow => ({
  periodMonth: m,
  amountCents: toCents(usd),
  kind: "invoiced",
  note,
});

describe("toCents / formatUsd", () => {
  it("round-trips ordinary amounts", () => {
    expect(toCents(108.88)).toBe(10888);
    expect(formatUsd(10888)).toBe("$108.88");
  });

  it("does not accumulate rounding error across a year", () => {
    /* Cents, not floats, is the whole reason this type exists: twelve
       additions of 108.88 in floating point does not equal 1306.56. */
    const total = Array.from({ length: 12 }, () => toCents(108.88)).reduce((a, b) => a + b, 0);
    expect(formatUsd(total)).toBe("$1306.56");
  });

  it("says 'not recorded' rather than $0.00 for a missing figure", () => {
    // $0.00 is a claim that nothing was spent. Missing is not that claim.
    expect(formatUsd(null)).toBe("not recorded");
  });
});

describe("monthKey", () => {
  it("is the first of the month, in UTC", () => {
    expect(monthKey(new Date("2026-03-28T23:30:00Z"))).toBe("2026-03-01");
    expect(monthKey(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01");
  });
});

describe("compareMonths", () => {
  it("subtracts measured from baseline when both are known", () => {
    const r = compareMonths([invoiced("2026-03-01", 108.88)], [
      { periodMonth: "2026-03-01", cents: toCents(12.4) },
    ]);
    expect(r[0].differenceCents).toBe(toCents(96.48));
  });

  it("REFUSES a difference when the router recorded nothing that month", () => {
    /* The months before the router existed have no measured side. Treating
       that as zero would report the entire old bill as a saving, which is the
       most flattering possible lie this code could tell. */
    const r = compareMonths([invoiced("2026-01-01", 21.78)], []);
    expect(r[0].baselineCents).toBe(toCents(21.78));
    expect(r[0].measuredCents).toBeNull();
    expect(r[0].differenceCents).toBeNull();
  });

  it("refuses a difference when no baseline was recorded", () => {
    const r = compareMonths([], [{ periodMonth: "2026-08-01", cents: toCents(3) }]);
    expect(r[0].differenceCents).toBeNull();
  });

  it("keeps months that exist on only one side", () => {
    // Dropping them would shorten the history that makes this worth reading.
    const r = compareMonths([invoiced("2026-01-01", 21.78)], [
      { periodMonth: "2026-08-01", cents: toCents(3) },
    ]);
    expect(r.map((m) => m.periodMonth)).toEqual(["2026-01-01", "2026-08-01"]);
  });

  it("reports a rise as a negative difference rather than hiding it", () => {
    /* Metered spend CAN exceed a flat subscription. A comparison that can only
       show savings is an advertisement. */
    const r = compareMonths([invoiced("2026-08-01", 20)], [
      { periodMonth: "2026-08-01", cents: toCents(35) },
    ]);
    expect(r[0].differenceCents).toBe(toCents(-15));
  });

  it("returns months in date order", () => {
    const r = compareMonths(
      [invoiced("2026-03-01", 108.88), invoiced("2026-01-01", 21.78), invoiced("2026-02-01", 87.77)],
      [],
    );
    expect(r.map((m) => m.periodMonth)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
  });

  it("carries the kind and note through, so provenance reaches the page", () => {
    const r = compareMonths(
      [{ periodMonth: "2026-04-01", amountCents: 10888, kind: "recurring_estimate", note: "assumed" }],
      [{ periodMonth: "2026-04-01", cents: 100 }],
    );
    expect(r[0].baselineKind).toBe("recurring_estimate");
    expect(r[0].baselineNote).toBe("assumed");
  });
});

describe("summarize", () => {
  const months = compareMonths(
    [
      invoiced("2026-01-01", 21.78),
      invoiced("2026-02-01", 87.77),
      invoiced("2026-03-01", 108.88),
    ],
    [{ periodMonth: "2026-03-01", cents: toCents(8.88) }],
  );

  it("totals ONLY the months where both sides are known", () => {
    /* Summing every baseline against a partial measured side would report the
       whole of January and February as saved, when the router simply was not
       running then. */
    const s = summarize(months);
    expect(s.comparableMonths).toBe(1);
    expect(s.totalBaselineCents).toBe(toCents(108.88));
    expect(s.totalMeasuredCents).toBe(toCents(8.88));
    expect(s.totalDifferenceCents).toBe(toCents(100));
  });

  it("says when a total leans on an assumed rate", () => {
    const s = summarize(
      compareMonths(
        [{ periodMonth: "2026-05-01", amountCents: 10888, kind: "recurring_estimate", note: null }],
        [{ periodMonth: "2026-05-01", cents: 500 }],
      ),
    );
    expect(s.includesEstimate).toBe(true);
  });

  it("does not claim an estimate when every comparable month is invoiced", () => {
    expect(summarize(months).includesEstimate).toBe(false);
  });

  it("totals zero, not NaN, when nothing is comparable", () => {
    const s = summarize(compareMonths([invoiced("2026-01-01", 21.78)], []));
    expect(s.comparableMonths).toBe(0);
    expect(s.totalDifferenceCents).toBe(0);
  });
});
