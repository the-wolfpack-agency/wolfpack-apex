/**
 * Unit tests for the cross-scan correlation engine (correlate.ts) - the tested
 * heart of the moat.
 *
 * One test per insight kind proving it FIRES on the right shape and does NOT fire
 * on benign data, plus the cross-cutting guarantees: severity elevation on a
 * compound risk, and stable/deterministic dedup keys across re-runs.
 *
 * The engine is pure, so these are pure input->output assertions: no DB, no
 * analytics, no clock except the injected one.
 */

import {
  correlateFindings,
  type CorrelationFinding,
  type CorrelationHistory,
} from "@/lib/platform-scan/insights/correlate";

function f(
  partial: Partial<CorrelationFinding> & Pick<CorrelationFinding, "platform" | "route" | "category">,
): CorrelationFinding {
  return {
    severity: "medium",
    title: `${partial.category} on ${partial.route}`,
    ...partial,
  };
}

// A fixed clock so regression gap-in-days is deterministic.
const NOW = Date.parse("2026-06-28T00:00:00.000Z");
const opts = { now: () => NOW };

describe("compound_risk", () => {
  test("fires when >=2 distinct modalities land on the SAME route", () => {
    const findings = [
      f({ platform: "acme", route: "/checkout", category: "security", severity: "high", title: "Missing CSRF token" }),
      f({ platform: "acme", route: "/checkout", category: "broken_journey", severity: "medium", title: "Payment step 500s" }),
    ];
    const insights = correlateFindings(findings, undefined, opts);
    const cr = insights.filter((i) => i.kind === "compound_risk");
    expect(cr).toHaveLength(1);
    expect(cr[0].platform).toBe("acme");
    expect(cr[0].modalities.sort()).toEqual(["broken_journey", "security"]);
    expect(cr[0].members).toHaveLength(2);
  });

  test("does NOT fire when a route has findings of only ONE modality", () => {
    const findings = [
      f({ platform: "acme", route: "/a", category: "security", title: "x" }),
      f({ platform: "acme", route: "/a", category: "security", title: "y" }),
    ];
    const insights = correlateFindings(findings, undefined, opts);
    expect(insights.filter((i) => i.kind === "compound_risk")).toHaveLength(0);
  });

  test("does NOT fire when two modalities are on DIFFERENT routes", () => {
    const findings = [
      f({ platform: "acme", route: "/a", category: "security" }),
      f({ platform: "acme", route: "/b", category: "performance" }),
    ];
    const insights = correlateFindings(findings, undefined, opts);
    expect(insights.filter((i) => i.kind === "compound_risk")).toHaveLength(0);
  });

  test("ELEVATES severity above the worst single member", () => {
    const findings = [
      f({ platform: "acme", route: "/x", category: "security", severity: "high" }),
      f({ platform: "acme", route: "/x", category: "performance", severity: "low" }),
    ];
    const [cr] = correlateFindings(findings, undefined, opts).filter((i) => i.kind === "compound_risk");
    // worst member is high -> elevated to critical.
    expect(cr.severity).toBe("critical");
  });

  test("caps elevation at critical (does not overflow)", () => {
    const findings = [
      f({ platform: "acme", route: "/x", category: "security", severity: "critical" }),
      f({ platform: "acme", route: "/x", category: "bug", severity: "high" }),
    ];
    const [cr] = correlateFindings(findings, undefined, opts).filter((i) => i.kind === "compound_risk");
    expect(cr.severity).toBe("critical");
  });
});

describe("regression", () => {
  const history: CorrelationHistory = {
    resolved: [
      {
        platform: "acme",
        route: "/login",
        category: "security",
        title: "SQL injection",
        resolvedAt: "2026-06-18T00:00:00.000Z", // 10 days before NOW
      },
    ],
  };

  test("fires when a resolved finding class is OPEN again, with a gap in days", () => {
    const findings = [f({ platform: "acme", route: "/login", category: "security", title: "SQL injection", severity: "critical" })];
    const insights = correlateFindings(findings, history, opts);
    const reg = insights.filter((i) => i.kind === "regression");
    expect(reg).toHaveLength(1);
    expect(reg[0].severity).toBe("critical");
    expect(reg[0].narrative).toContain("10 days ago");
  });

  test("does NOT fire when the current finding was never resolved (no history match)", () => {
    const findings = [f({ platform: "acme", route: "/other", category: "security", title: "Different bug" })];
    const insights = correlateFindings(findings, history, opts);
    expect(insights.filter((i) => i.kind === "regression")).toHaveLength(0);
  });

  test("does NOT fire with no history at all", () => {
    const findings = [f({ platform: "acme", route: "/login", category: "security", title: "SQL injection" })];
    const insights = correlateFindings(findings, undefined, opts);
    expect(insights.filter((i) => i.kind === "regression")).toHaveLength(0);
  });
});

describe("systemic_pattern", () => {
  test("fires when the same class appears across >=N (default 2) distinct targets", () => {
    const findings = [
      f({ platform: "acme", route: "/a", category: "security", title: "Missing HSTS", severity: "medium" }),
      f({ platform: "globex", route: "/z", category: "security", title: "Missing HSTS", severity: "high" }),
    ];
    const insights = correlateFindings(findings, undefined, opts);
    const sys = insights.filter((i) => i.kind === "systemic_pattern");
    expect(sys).toHaveLength(1);
    expect(sys[0].platform).toBe("all");
    expect(sys[0].severity).toBe("high"); // peak across targets
    expect(sys[0].narrative).toContain("acme");
    expect(sys[0].narrative).toContain("globex");
  });

  test("does NOT fire when the class is on only ONE target", () => {
    const findings = [
      f({ platform: "acme", route: "/a", category: "security", title: "Missing HSTS" }),
      f({ platform: "acme", route: "/b", category: "security", title: "Missing HSTS" }),
    ];
    const insights = correlateFindings(findings, undefined, opts);
    expect(insights.filter((i) => i.kind === "systemic_pattern")).toHaveLength(0);
  });

  test("respects a raised systemicMinTargets threshold", () => {
    const findings = [
      f({ platform: "acme", route: "/a", category: "bug", title: "Same bug" }),
      f({ platform: "globex", route: "/b", category: "bug", title: "Same bug" }),
    ];
    // Two targets -> below a threshold of 3 -> no systemic insight.
    const insights = correlateFindings(findings, undefined, { ...opts, systemicMinTargets: 3 });
    expect(insights.filter((i) => i.kind === "systemic_pattern")).toHaveLength(0);
  });
});

describe("coverage_blind_spot", () => {
  test("fires when a scanned target is missing a whole modality", () => {
    // acme has findings in 4 of 5 categories; "performance" was never exercised.
    const findings = [
      f({ platform: "acme", route: "/a", category: "bug" }),
      f({ platform: "acme", route: "/b", category: "ux_gap" }),
      f({ platform: "acme", route: "/c", category: "broken_journey" }),
      f({ platform: "acme", route: "/d", category: "security" }),
    ];
    const insights = correlateFindings(findings, undefined, opts);
    const bs = insights.filter((i) => i.kind === "coverage_blind_spot");
    expect(bs).toHaveLength(1);
    expect(bs[0].platform).toBe("acme");
    expect(bs[0].modalities).toEqual(["performance"]);
    expect(bs[0].members).toHaveLength(0); // the point is what's MISSING
  });

  test("does NOT fire when every expected category was exercised", () => {
    const findings = [
      f({ platform: "acme", route: "/a", category: "bug" }),
      f({ platform: "acme", route: "/b", category: "ux_gap" }),
      f({ platform: "acme", route: "/c", category: "broken_journey" }),
      f({ platform: "acme", route: "/d", category: "security" }),
      f({ platform: "acme", route: "/e", category: "performance" }),
    ];
    const insights = correlateFindings(findings, undefined, opts);
    expect(insights.filter((i) => i.kind === "coverage_blind_spot")).toHaveLength(0);
  });

  test("honors a narrowed expectedCategories set", () => {
    // Only expect security + performance; acme has both -> no blind spot.
    const findings = [
      f({ platform: "acme", route: "/a", category: "security" }),
      f({ platform: "acme", route: "/b", category: "performance" }),
    ];
    const insights = correlateFindings(findings, undefined, {
      ...opts,
      expectedCategories: ["security", "performance"],
    });
    expect(insights.filter((i) => i.kind === "coverage_blind_spot")).toHaveLength(0);
  });
});

describe("dedup keys + determinism", () => {
  test("the same logical insight produces the SAME key across re-runs", () => {
    const findings = [
      f({ platform: "acme", route: "/x", category: "security", severity: "high" }),
      f({ platform: "acme", route: "/x", category: "performance", severity: "low" }),
    ];
    const a = correlateFindings(findings, undefined, opts);
    const b = correlateFindings(findings, undefined, opts);
    expect(a.map((i) => i.key)).toEqual(b.map((i) => i.key));
    // And the key is stable, content-derived (not random).
    const cr = a.find((i) => i.kind === "compound_risk")!;
    expect(cr.key).toBe("compound_risk::acme::/x::performance+security");
  });

  test("identical input yields byte-identical, sorted output (deterministic)", () => {
    const findings = [
      f({ platform: "acme", route: "/x", category: "security", severity: "high" }),
      f({ platform: "acme", route: "/x", category: "performance", severity: "low" }),
      f({ platform: "globex", route: "/y", category: "bug", title: "Same bug" }),
      f({ platform: "acme", route: "/z", category: "bug", title: "Same bug" }),
    ];
    const a = JSON.stringify(correlateFindings(findings, undefined, opts));
    const b = JSON.stringify(correlateFindings(findings.slice().reverse(), undefined, opts));
    expect(a).toBe(b);
  });

  test("returns no insights for benign single-finding data", () => {
    const findings = [f({ platform: "acme", route: "/a", category: "bug" })];
    // One finding, one modality -> only a blind spot is possible; assert no
    // compound/regression/systemic noise.
    const insights = correlateFindings(findings, undefined, opts);
    expect(insights.filter((i) => i.kind === "compound_risk")).toHaveLength(0);
    expect(insights.filter((i) => i.kind === "regression")).toHaveLength(0);
    expect(insights.filter((i) => i.kind === "systemic_pattern")).toHaveLength(0);
  });
});
