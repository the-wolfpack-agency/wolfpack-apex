/**
 * Compliance report generator + crosswalk. Proves: healthy evidence yields high
 * coverage, an empty/cold system yields gaps (honest, not blanket-compliant),
 * every framework has controls and each control maps to an OGIAM capability, and
 * the report is deterministic.
 */
import { generateReport } from "../report";
import { FRAMEWORKS, ALL_FRAMEWORKS } from "../frameworks";
import type { EvidenceInputs } from "../types";

const healthy: EvidenceInputs = {
  auditChainValid: true,
  auditEntries: 1200,
  gateDecisions: 5000,
  gateWouldBlock: 80,
  enforceCapabilities: 6,
  redteamPassRate: 1,
  redteamRecent: true,
  aiSurfacesTotal: 40,
  ungovernedAiSurfaces: 0,
};

const cold: EvidenceInputs = {
  auditChainValid: false,
  auditEntries: 0,
  gateDecisions: 0,
  gateWouldBlock: 0,
  enforceCapabilities: 0,
  redteamPassRate: null,
  redteamRecent: false,
  aiSurfacesTotal: 0,
  ungovernedAiSurfaces: 0,
};

test("a healthy system reports high coverage across every framework", () => {
  for (const fw of ALL_FRAMEWORKS) {
    const r = generateReport(fw, healthy);
    expect(r.controls.length).toBeGreaterThan(0);
    expect(r.gap).toBe(0);
    expect(r.coverage).toBeGreaterThanOrEqual(0.75);
  }
});

test("a cold system honestly reports gaps, not blanket compliance", () => {
  const r = generateReport("EU_AI_ACT", cold);
  expect(r.coverage).toBeLessThan(1);
  expect(r.gap + r.partial).toBeGreaterThan(0);
  // Record-keeping with no ledger is a hard gap, not a partial.
  expect(r.controls.find((c) => c.id === "EUAIACT-ART12")?.status).toBe("gap");
});

test("ungoverned AI downgrades the NIST MAP control to partial", () => {
  const r = generateReport("NIST_AI_RMF", { ...healthy, ungovernedAiSurfaces: 5 });
  expect(r.controls.find((c) => c.id === "NIST-MAP")?.status).toBe("partial");
});

test("every control names an OGIAM capability and a rationale", () => {
  for (const fw of ALL_FRAMEWORKS) {
    for (const c of FRAMEWORKS[fw]) {
      expect(c.ogiamControl.length).toBeGreaterThan(0);
      expect(c.rationale.length).toBeGreaterThan(0);
    }
  }
});

test("the report is deterministic for the same evidence", () => {
  expect(generateReport("SOC2", healthy)).toEqual(generateReport("SOC2", healthy));
});

test("each result carries a human-readable evidence string", () => {
  const r = generateReport("SOC2", healthy);
  expect(r.controls.every((c) => typeof c.evidence === "string" && c.evidence.length > 0)).toBe(true);
});
