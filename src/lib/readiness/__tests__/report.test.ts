/**
 * The readiness report aggregator: pure grading + scoring, no I/O.
 */
import { gradeTool, scorePct } from "@/lib/readiness/report";
import type { ReadinessCriterion, ToolSignals, ToolSpec } from "@/lib/readiness/types";

const crit = (
  id: string,
  dimension: ReadinessCriterion["dimension"],
  status: ReadinessCriterion["status"],
): ReadinessCriterion => ({
  id,
  dimension,
  kind: "auto",
  title: id,
  rationale: "r",
  status,
  evidence: () => "e",
});

const ready = () => "ready" as const;
const partial = () => "partial" as const;
const gap = () => "gap" as const;

const spec: ToolSpec = {
  id: "t",
  label: "T",
  surface: "/t",
  collectSignals: () => ({}),
  criteria: [
    crit("a", "tests", ready),
    crit("b", "tests", partial),
    crit("c", "isolation", gap),
    crit("d", "isolation", ready),
  ],
};

describe("gradeTool", () => {
  const r = gradeTool(spec, {} as ToolSignals);

  it("counts ready/partial/gap and totals", () => {
    expect(r.ready).toBe(2);
    expect(r.partial).toBe(1);
    expect(r.gap).toBe(1);
    expect(r.total).toBe(4);
  });

  it("scores partial as half credit", () => {
    // (1 + 0.5 + 0 + 1) / 4 = 0.625
    expect(r.score).toBeCloseTo(0.625, 5);
    expect(scorePct(r.score)).toBe(63);
  });

  it("scores per dimension", () => {
    expect(r.byDimension.tests.score).toBeCloseTo(0.75, 5); // ready + partial
    expect(r.byDimension.isolation.score).toBeCloseTo(0.5, 5); // gap + ready
  });

  it("preserves each criterion's status + evidence", () => {
    expect(r.results.map((x) => x.status)).toEqual(["ready", "partial", "gap", "ready"]);
    expect(r.results[0].evidence).toBe("e");
  });

  it("an all-gap tool scores 0, an all-ready tool scores 1", () => {
    const allGap = gradeTool({ ...spec, criteria: [crit("x", "tests", gap)] }, {});
    const allReady = gradeTool({ ...spec, criteria: [crit("x", "tests", ready)] }, {});
    expect(allGap.score).toBe(0);
    expect(allReady.score).toBe(1);
  });
});
