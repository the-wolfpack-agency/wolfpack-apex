/**
 * Unit tests for the cross-scan correlation engine (correlate.ts) - the tested
 * heart of the moat.
 *
 * One test per insight kind proving it FIRES on the right shape and does NOT fire
 * on benign data, plus the cross-cutting guarantees and the adversarial-audit
 * regressions:
 *   - FIX 3: a clean-SCANNED modality is NOT a blind spot (coverage-driven, not
 *            absence-of-findings driven).
 *   - FIX 4: query-string variants of one route group together; file vs URL paths
 *            do not falsely merge.
 *   - FIX 5: routes/titles containing `::` or `+` keep DISTINCT dedup keys.
 *   - FIX 6: a regression FIRES from real resolved-then-reopened state but NOT when
 *            the resolution post-dates the open, nor when resolvedAt is future.
 *   - FIX 7: elevation floor - low+low does not become high, high+low is not
 *            auto-critical.
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

  // FIX 7: elevation policy is conditional, not unconditional +1.
  test("ELEVATES to critical when TWO members are high", () => {
    const findings = [
      f({ platform: "acme", route: "/x", category: "security", severity: "high" }),
      f({ platform: "acme", route: "/x", category: "performance", severity: "high" }),
    ];
    const [cr] = correlateFindings(findings, undefined, opts).filter((i) => i.kind === "compound_risk");
    expect(cr.severity).toBe("critical");
  });

  test("FIX 7: high + low does NOT become critical (no auto-elevation from one substantial member)", () => {
    const findings = [
      f({ platform: "acme", route: "/x", category: "security", severity: "high" }),
      f({ platform: "acme", route: "/x", category: "performance", severity: "low" }),
    ];
    const [cr] = correlateFindings(findings, undefined, opts).filter((i) => i.kind === "compound_risk");
    // Only one substantial member -> no elevation -> stays at the peak (high).
    expect(cr.severity).toBe("high");
  });

  test("FIX 7: elevation FLOOR - low + low does NOT become high", () => {
    const findings = [
      f({ platform: "acme", route: "/x", category: "security", severity: "low" }),
      f({ platform: "acme", route: "/x", category: "performance", severity: "low" }),
    ];
    const [cr] = correlateFindings(findings, undefined, opts).filter((i) => i.kind === "compound_risk");
    expect(cr.severity).toBe("low");
  });

  test("FIX 7: two mediums elevate one band to high (capped, never critical)", () => {
    const findings = [
      f({ platform: "acme", route: "/x", category: "security", severity: "medium" }),
      f({ platform: "acme", route: "/x", category: "performance", severity: "medium" }),
    ];
    const [cr] = correlateFindings(findings, undefined, opts).filter((i) => i.kind === "compound_risk");
    expect(cr.severity).toBe("high");
  });

  test("caps elevation at critical (does not overflow)", () => {
    const findings = [
      f({ platform: "acme", route: "/x", category: "security", severity: "critical" }),
      f({ platform: "acme", route: "/x", category: "bug", severity: "high" }),
    ];
    const [cr] = correlateFindings(findings, undefined, opts).filter((i) => i.kind === "compound_risk");
    expect(cr.severity).toBe("critical");
  });

  // FIX 4: route normalization.
  test("FIX 4: query-string variants of one route GROUP TOGETHER into one chain", () => {
    const findings = [
      f({ platform: "acme", route: "/checkout?utm=a", category: "security", severity: "high" }),
      f({ platform: "acme", route: "/checkout?utm=b#frag", category: "performance", severity: "high" }),
      f({ platform: "acme", route: "/checkout/", category: "broken_journey", severity: "high" }),
    ];
    const cr = correlateFindings(findings, undefined, opts).filter((i) => i.kind === "compound_risk");
    // All three normalize to /checkout -> ONE compound risk spanning 3 modalities.
    expect(cr).toHaveLength(1);
    expect(cr[0].modalities.sort()).toEqual(["broken_journey", "performance", "security"]);
  });

  test("FIX 4: a file path and a URL path that share text do NOT falsely merge", () => {
    // "checkout" appears in both, but one is a file path and one a URL path.
    const findings = [
      f({ platform: "acme", route: "/checkout", category: "security", severity: "high" }),
      f({ platform: "acme", route: "src/checkout.ts", category: "performance", severity: "high" }),
    ];
    const cr = correlateFindings(findings, undefined, opts).filter((i) => i.kind === "compound_risk");
    // Different namespaces -> NOT the same resource -> no compound risk.
    expect(cr).toHaveLength(0);
  });
});

describe("regression", () => {
  const baseResolved = {
    platform: "acme",
    route: "/login",
    category: "security" as const,
    title: "SQL injection",
  };

  test("FIX 6: FIRES when a resolved finding REOPENED (resolvedAt < open.createdAt)", () => {
    const history: CorrelationHistory = {
      resolved: [{ ...baseResolved, resolvedAt: "2026-06-18T00:00:00.000Z" }], // 10d before NOW
    };
    const findings = [
      f({
        ...baseResolved,
        severity: "critical",
        // Opened AFTER it was resolved -> a genuine reopen.
        createdAt: "2026-06-25T00:00:00.000Z",
      }),
    ];
    const reg = correlateFindings(findings, history, opts).filter((i) => i.kind === "regression");
    expect(reg).toHaveLength(1);
    expect(reg[0].severity).toBe("critical");
    expect(reg[0].narrative).toContain("10 days ago");
  });

  test("FIX 6: does NOT fire when the open finding pre-dates the resolution (resolved AFTER open)", () => {
    const history: CorrelationHistory = {
      resolved: [{ ...baseResolved, resolvedAt: "2026-06-25T00:00:00.000Z" }],
    };
    const findings = [
      f({
        ...baseResolved,
        severity: "high",
        // Opened BEFORE the "resolution" -> it never actually reopened; the
        // resolution simply post-dates a still-open finding. Not a regression.
        createdAt: "2026-06-10T00:00:00.000Z",
      }),
    ];
    expect(correlateFindings(findings, history, opts).filter((i) => i.kind === "regression")).toHaveLength(0);
  });

  test("FIX 6: does NOT fire when resolvedAt is FUTURE-DATED (untrustworthy ordering)", () => {
    const history: CorrelationHistory = {
      resolved: [{ ...baseResolved, resolvedAt: "2026-07-15T00:00:00.000Z" }], // after NOW
    };
    const findings = [f({ ...baseResolved, severity: "high", createdAt: "2026-06-25T00:00:00.000Z" })];
    expect(correlateFindings(findings, history, opts).filter((i) => i.kind === "regression")).toHaveLength(0);
  });

  test("FIX 6: does NOT fire when the open finding has no createdAt (ordering unprovable)", () => {
    const history: CorrelationHistory = {
      resolved: [{ ...baseResolved, resolvedAt: "2026-06-18T00:00:00.000Z" }],
    };
    const findings = [f({ ...baseResolved, severity: "high" })]; // no createdAt
    expect(correlateFindings(findings, history, opts).filter((i) => i.kind === "regression")).toHaveLength(0);
  });

  test("does NOT fire when the current finding was never resolved (no history match)", () => {
    const history: CorrelationHistory = {
      resolved: [{ ...baseResolved, resolvedAt: "2026-06-18T00:00:00.000Z" }],
    };
    const findings = [
      f({ platform: "acme", route: "/other", category: "security", title: "Different bug", createdAt: "2026-06-25T00:00:00.000Z" }),
    ];
    expect(correlateFindings(findings, history, opts).filter((i) => i.kind === "regression")).toHaveLength(0);
  });

  test("does NOT fire with no history at all", () => {
    const findings = [f({ ...baseResolved, createdAt: "2026-06-25T00:00:00.000Z" })];
    expect(correlateFindings(findings, undefined, opts).filter((i) => i.kind === "regression")).toHaveLength(0);
  });
});

describe("systemic_pattern", () => {
  test("fires when the same class appears across >=N (default 2) distinct targets", () => {
    const findings = [
      f({ platform: "acme", route: "/a", category: "security", title: "Missing HSTS", severity: "medium" }),
      f({ platform: "globex", route: "/z", category: "security", title: "Missing HSTS", severity: "high" }),
    ];
    const sys = correlateFindings(findings, undefined, opts).filter((i) => i.kind === "systemic_pattern");
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
    expect(correlateFindings(findings, undefined, opts).filter((i) => i.kind === "systemic_pattern")).toHaveLength(0);
  });

  test("respects a raised systemicMinTargets threshold", () => {
    const findings = [
      f({ platform: "acme", route: "/a", category: "bug", title: "Same bug" }),
      f({ platform: "globex", route: "/b", category: "bug", title: "Same bug" }),
    ];
    const insights = correlateFindings(findings, undefined, { ...opts, systemicMinTargets: 3 });
    expect(insights.filter((i) => i.kind === "systemic_pattern")).toHaveLength(0);
  });
});

describe("coverage_blind_spot (FIX 3 - coverage driven, not absence-of-findings driven)", () => {
  test("fires only when scan coverage proves a modality was NOT exercised", () => {
    const findings = [f({ platform: "acme", route: "/a", category: "bug" })];
    const insights = correlateFindings(findings, undefined, {
      ...opts,
      // acme scanned bug + ux_gap + broken_journey + security; performance never ran.
      scannedCategories: { acme: ["bug", "ux_gap", "broken_journey", "security"] },
    });
    const bs = insights.filter((i) => i.kind === "coverage_blind_spot");
    expect(bs).toHaveLength(1);
    expect(bs[0].platform).toBe("acme");
    expect(bs[0].modalities).toEqual(["performance"]);
    expect(bs[0].members).toHaveLength(0); // the point is what's MISSING
    expect(bs[0].narrative).toMatch(/never run/i);
  });

  test("FIX 3: a SCANNED-and-CLEAN modality is NOT reported as a blind spot", () => {
    // performance was scanned (it's in scannedCategories) but produced zero
    // findings. The old code inferred "never scanned" from the absence of findings
    // and falsely flagged it. It must NOT, now.
    const findings = [f({ platform: "acme", route: "/a", category: "bug" })];
    const insights = correlateFindings(findings, undefined, {
      ...opts,
      scannedCategories: { acme: ["bug", "ux_gap", "broken_journey", "security", "performance"] },
    });
    expect(insights.filter((i) => i.kind === "coverage_blind_spot")).toHaveLength(0);
  });

  test("FIX 3: with NO coverage data, NO blind spot is emitted (never assert a falsehood)", () => {
    // findings exist in 4 of 5 categories, but we have no positive evidence about
    // what actually ran -> emit nothing rather than fabricate "performance blind".
    const findings = [
      f({ platform: "acme", route: "/a", category: "bug" }),
      f({ platform: "acme", route: "/b", category: "ux_gap" }),
      f({ platform: "acme", route: "/c", category: "broken_journey" }),
      f({ platform: "acme", route: "/d", category: "security" }),
    ];
    expect(correlateFindings(findings, undefined, opts).filter((i) => i.kind === "coverage_blind_spot")).toHaveLength(0);
  });

  test("honors a narrowed expectedCategories set", () => {
    const insights = correlateFindings([], undefined, {
      ...opts,
      expectedCategories: ["security", "performance"],
      scannedCategories: { acme: ["security", "performance"] },
    });
    expect(insights.filter((i) => i.kind === "coverage_blind_spot")).toHaveLength(0);
  });
});

describe("dedup keys + determinism", () => {
  test("the same logical insight produces the SAME key across re-runs", () => {
    const findings = [
      f({ platform: "acme", route: "/x", category: "security", severity: "high" }),
      f({ platform: "acme", route: "/x", category: "performance", severity: "high" }),
    ];
    const a = correlateFindings(findings, undefined, opts);
    const b = correlateFindings(findings, undefined, opts);
    expect(a.map((i) => i.key)).toEqual(b.map((i) => i.key));
    // The key is stable + content-derived (hashed, prefixed by kind).
    const cr = a.find((i) => i.kind === "compound_risk")!;
    expect(cr.key).toMatch(/^compound_risk::[0-9a-f]{32}$/);
  });

  // FIX 5: keys built from raw fields collided when route/title contained `::`/`+`.
  test("FIX 5: two routes that DIFFER only by `::`/`+` content keep DISTINCT keys", () => {
    // Same platform, two routes whose raw concatenation under the OLD scheme would
    // have collided (`::` / `+` are the old delimiters). Each route gets its own
    // compound risk; the keys must differ.
    const findings = [
      f({ platform: "acme", route: "/a::b", category: "security", severity: "high" }),
      f({ platform: "acme", route: "/a::b", category: "performance", severity: "high" }),
      f({ platform: "acme", route: "/a", category: "security", severity: "high", title: "b::security::x" }),
      f({ platform: "acme", route: "/a", category: "performance", severity: "high", title: "y" }),
    ];
    const cr = correlateFindings(findings, undefined, opts).filter((i) => i.kind === "compound_risk");
    expect(cr).toHaveLength(2);
    const keys = cr.map((i) => i.key);
    expect(new Set(keys).size).toBe(2); // distinct, no collision
  });

  test("FIX 5: a title containing `::` does not collide a systemic_pattern key", () => {
    const findings = [
      f({ platform: "acme", route: "/a", category: "security", title: "x::y" }),
      f({ platform: "globex", route: "/z", category: "security", title: "x::y" }),
      f({ platform: "acme", route: "/a", category: "security", title: "x" }),
      f({ platform: "globex", route: "/z", category: "security", title: "x" }),
    ];
    const sys = correlateFindings(findings, undefined, opts).filter((i) => i.kind === "systemic_pattern");
    expect(sys).toHaveLength(2);
    expect(new Set(sys.map((i) => i.key)).size).toBe(2);
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
    const insights = correlateFindings(findings, undefined, opts);
    expect(insights.filter((i) => i.kind === "compound_risk")).toHaveLength(0);
    expect(insights.filter((i) => i.kind === "regression")).toHaveLength(0);
    expect(insights.filter((i) => i.kind === "systemic_pattern")).toHaveLength(0);
    expect(insights.filter((i) => i.kind === "coverage_blind_spot")).toHaveLength(0);
  });
});
