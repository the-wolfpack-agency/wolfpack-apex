/**
 * Unit tests for the PURE UX/accessibility posture scorer (ux-posture.ts).
 *
 * Asserts the grading contract the report relies on:
 *   - 0 ux_gap findings -> grade A.
 *   - one high dominates many lows (the weighted-scheme justification).
 *   - the a11y vs ux split keys off the "Accessibility:" title prefix.
 *   - the documented score boundaries map to the right letters.
 *   - ONLY ux_gap is counted; security/bug/performance/broken_journey ignored.
 *   - determinism: same input -> same output.
 */
import {
  scoreUxPosture,
  gradeFromScore,
  isAccessibilityFinding,
  UX_SEVERITY_WEIGHT,
} from "@/lib/platform-scan/ux-posture";
import type { ScanFinding, ScanSeverity, ScanCategory } from "@/lib/platform-scan/types";

function f(
  over: Partial<ScanFinding> & { severity: ScanSeverity; category?: ScanCategory; title?: string },
): ScanFinding {
  return {
    route: "/x",
    detail: "",
    evidence: {},
    category: "ux_gap",
    title: "Some UX gap",
    ...over,
  };
}

describe("scoreUxPosture", () => {
  it("0 findings -> grade A, all zero", () => {
    const r = scoreUxPosture([]);
    expect(r.grade).toBe("A");
    expect(r).toMatchObject({ ux: 0, a11y: 0, total: 0, score: 0 });
    expect(r.bySeverity).toEqual({ high: 0, medium: 0, low: 0 });
  });

  it("0 ux_gap findings (only other categories) -> grade A", () => {
    const r = scoreUxPosture([
      f({ severity: "critical", category: "security" }),
      f({ severity: "high", category: "bug" }),
      f({ severity: "high", category: "broken_journey" }),
      f({ severity: "medium", category: "performance" }),
    ]);
    expect(r.grade).toBe("A");
    expect(r.total).toBe(0);
    expect(r.score).toBe(0);
  });

  it("a single HIGH dominates many LOWs (weighted, not count-based)", () => {
    const oneHigh = scoreUxPosture([f({ severity: "high" })]);
    const nineLows = scoreUxPosture(Array.from({ length: 9 }, () => f({ severity: "low" })));
    // Count-based would rank nine lows as far WORSE than one high. Weighted does
    // the opposite: one high (D) is graded worse than nine lows (C).
    expect(oneHigh.grade).toBe("D");
    expect(nineLows.grade).toBe("C");
    expect(oneHigh.score).toBeGreaterThan(nineLows.score);
  });

  it("splits a11y vs ux by the 'Accessibility:' title prefix", () => {
    const r = scoreUxPosture([
      f({ severity: "low", title: "Accessibility: image missing alt text" }),
      f({ severity: "low", title: "accessibility: low contrast ratio" }), // case-insensitive
      f({ severity: "low", title: "Empty state missing on the dashboard" }),
    ]);
    expect(r.a11y).toBe(2);
    expect(r.ux).toBe(1);
    expect(r.total).toBe(3);
  });

  it("isAccessibilityFinding matches the prefix case-insensitively, trims", () => {
    expect(isAccessibilityFinding(f({ severity: "low", title: "Accessibility: x" }))).toBe(true);
    expect(isAccessibilityFinding(f({ severity: "low", title: "  accessibility: y" }))).toBe(true);
    expect(isAccessibilityFinding(f({ severity: "low", title: "Usability: z" }))).toBe(false);
    expect(isAccessibilityFinding(f({ severity: "low", title: "uses accessibility apis" }))).toBe(false);
  });

  it("counts ONLY ux_gap; security/bug/performance/broken_journey ignored", () => {
    const r = scoreUxPosture([
      f({ severity: "high", category: "ux_gap" }),
      f({ severity: "high", category: "security" }),
      f({ severity: "high", category: "bug" }),
      f({ severity: "high", category: "performance" }),
      f({ severity: "high", category: "broken_journey" }),
    ]);
    expect(r.total).toBe(1);
    expect(r.score).toBe(UX_SEVERITY_WEIGHT.high);
    expect(r.bySeverity.high).toBe(1);
  });

  it("folds critical into the high band for the headline", () => {
    const r = scoreUxPosture([f({ severity: "critical" })]);
    expect(r.bySeverity.high).toBe(1);
    expect(r.bySeverity.medium).toBe(0);
    expect(r.score).toBe(UX_SEVERITY_WEIGHT.critical);
    expect(r.grade).toBe("F"); // critical (20) -> F
  });

  it("is deterministic: identical input -> identical output", () => {
    const input = [f({ severity: "high" }), f({ severity: "low", title: "Accessibility: x" })];
    expect(scoreUxPosture(input)).toEqual(scoreUxPosture(input));
  });
});

describe("gradeFromScore boundary thresholds", () => {
  it("maps each documented band to the right letter", () => {
    expect(gradeFromScore(0)).toBe("A");
    expect(gradeFromScore(1)).toBe("B"); // one low
    expect(gradeFromScore(2)).toBe("B"); // two lows (upper edge)
    expect(gradeFromScore(3)).toBe("C"); // one medium (lower edge)
    expect(gradeFromScore(9)).toBe("C"); // upper edge of C
    expect(gradeFromScore(10)).toBe("D"); // one high (lower edge)
    expect(gradeFromScore(19)).toBe("D"); // upper edge of D
    expect(gradeFromScore(20)).toBe("F"); // two highs / one critical
    expect(gradeFromScore(100)).toBe("F");
  });

  it("each grade is reachable from a real finding mix", () => {
    expect(scoreUxPosture([]).grade).toBe("A");
    expect(scoreUxPosture([f({ severity: "low" })]).grade).toBe("B"); // 1
    expect(scoreUxPosture([f({ severity: "medium" })]).grade).toBe("C"); // 3
    expect(scoreUxPosture([f({ severity: "high" })]).grade).toBe("D"); // 10
    expect(scoreUxPosture([f({ severity: "high" }), f({ severity: "high" })]).grade).toBe("F"); // 20
  });
});
