/**
 * Gap #4 honestly: the benchmark must detect what deception + structure catch,
 * and REPORT the profiles it misses rather than pretend to catch them.
 */
import { benchmarkLowAndSlow } from "@/lib/forcefield/low-and-slow";

describe("low-and-slow detection benchmark", () => {
  const report = benchmarkLowAndSlow();
  const by = Object.fromEntries(report.profiles.map((p) => [p.id, p.detected]));

  it("detects the structural / deception-tripping profiles even when paced", () => {
    expect(by["greedy-decoy"]).toBe(true);
    expect(by["sensitive-prober"]).toBe(true);
    expect(by["form-honeypot"]).toBe(true);
    expect(by["slow-enumerator"]).toBe(true); // IDOR is rate-independent
  });

  it("HONESTLY reports the residual gap - a passive, decoy-avoiding, human-paced agent is missed", () => {
    expect(by["patient-passive"]).toBe(false);
    expect(by["decoy-avoider"]).toBe(false);
    // it never claims to catch every evasive profile
    expect(report.evasiveRate).toBeLessThan(100);
    expect(report.note).toMatch(/residual gap|not a guarantee|rather than claim 100/i);
  });

  it("reports rates and the honest hard number separately", () => {
    expect(report.rate).toBeGreaterThan(0);
    expect(report.rate).toBeLessThanOrEqual(100);
    expect(report.total).toBe(report.profiles.length);
  });
});
