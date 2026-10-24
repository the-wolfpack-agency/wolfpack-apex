/**
 * Vacuous-pass regressions for the compliance crosswalk.
 *
 * Each test feeds the evidence shape that USED to read "covered" without the
 * control executing, and asserts it no longer does. These are the audit's
 * findings, pinned:
 *   - CC6.1 / NIST-MANAGE / EU ART14 were "covered" on any gate decision, even
 *     at 100% monitor mode.
 *   - CC7.3 was "covered" on `gateWouldBlock >= 0`, which is always true.
 *   - Every red-team-backed control was "covered" on a 100% pass of a fixed
 *     8-literal regression set that never touches a model.
 *   - CC6.7 / ISO A.8.3 were "covered" when an encrypt/decrypt probe round-
 *     tripped, even with the development key and plaintext tokens in the DB.
 *   - CC6.6 was "covered" from a committed baseline while every RLS policy is
 *     USING(true) and the app role bypasses RLS.
 *   - Signing was "active" from a configured signer that never signed a record.
 */
import { generateReport } from "../report";
import { ALL_FRAMEWORKS, FRAMEWORKS } from "../frameworks";
import type { ComplianceFramework, EvidenceInputs } from "../types";
import { HEALTHY, VACUOUS } from "./evidence-fixtures";

const statusOf = (fw: ComplianceFramework, id: string, e: EvidenceInputs) =>
  generateReport(fw, e).controls.find((c) => c.id === id)?.status;

describe("the vacuous fixture never reads covered", () => {
  it.each(ALL_FRAMEWORKS.flatMap((fw) => FRAMEWORKS[fw].map((c) => [fw, c.id] as const)))(
    "%s %s",
    (fw, id) => {
      // Ledger controls are backed by a chain verification that really ran in
      // the fixture, so they may stay covered; everything else must not.
      const ledgerBacked = ["SOC2-CC4.1", "ISO42001-A.7.4", "NIST-GOVERN", "EUAIACT-ART12", "NIST-MAP"];
      const s = statusOf(fw, id, VACUOUS);
      if (ledgerBacked.includes(id)) return;
      expect(s).not.toBe("covered");
    },
  );
});

describe("per-control vacuous cases (each must FAIL to cover)", () => {
  test("CC6.1: lots of monitor-only decisions is not access control", () => {
    expect(statusOf("SOC2", "SOC2-CC6.1", { ...HEALTHY, gateEnforcedWindow: 0, gateEnforcedBlocksWindow: 0 })).toBe("partial");
    expect(statusOf("SOC2", "SOC2-CC6.1", { ...HEALTHY, enforceCapabilities: 0 })).toBe("partial");
    expect(statusOf("SOC2", "SOC2-CC6.1", { ...HEALTHY, gateWindowMeasured: false })).toBe("gap");
    expect(statusOf("SOC2", "SOC2-CC6.1", HEALTHY)).toBe("covered");
  });

  test("CC7.3: zero would-block decisions no longer satisfies `>= 0`", () => {
    const e = { ...HEALTHY, gateWouldBlock: 0, gateEnforcedBlocksWindow: 0, gateWouldBlockWindow: 0 };
    expect(statusOf("SOC2", "SOC2-CC7.3", e)).toBe("gap");
    expect(statusOf("SOC2", "SOC2-CC7.3", { ...e, gateWouldBlockWindow: 3 })).toBe("partial");
    expect(statusOf("SOC2", "SOC2-CC7.3", HEALTHY)).toBe("covered");
  });

  test("red-team controls: a 100% fixed-regression pass is partial, never covered", () => {
    const fixed = { ...HEALTHY, redteamKind: "fixed_regression" as const, redteamCases: 8, redteamPassRate: 1, redteamRecent: true };
    for (const [fw, id] of [
      ["SOC2", "SOC2-CC7.2"],
      ["ISO42001", "ISO42001-A.6.2"],
      ["NIST_AI_RMF", "NIST-MEASURE"],
      ["EU_AI_ACT", "EUAIACT-ART9"],
      ["EU_AI_ACT", "EUAIACT-ART15"],
    ] as const) {
      expect(statusOf(fw, id, fixed)).toBe("partial");
      // a stale run is a gap, not partial
      expect(statusOf(fw, id, { ...fixed, redteamRecent: false, aiSurfacesTotal: 0 })).toBe("gap");
    }
    expect(generateReport("SOC2", fixed).controls.find((c) => c.id === "SOC2-CC7.2")?.evidence).toMatch(/not red-team coverage/);
  });

  test("CC6.7 / ISO A.8.3: a round-tripping probe with plaintext tokens is not encryption at rest", () => {
    const e = { ...HEALTHY, secretsEncryptedAtRest: true, storedOauthPlaintext: 6 };
    expect(statusOf("SOC2", "SOC2-CC6.7", e)).not.toBe("covered");
    expect(statusOf("ISO42001", "ISO42001-A.8.3", e)).not.toBe("covered");
    // the development-literal key is not protection either
    expect(statusOf("SOC2", "SOC2-CC6.7", { ...HEALTHY, kekSource: "dev-literal" })).not.toBe("covered");
    // unmeasured stored counts are not a pass
    expect(statusOf("SOC2", "SOC2-CC6.7", { ...HEALTHY, storedOauthPlaintext: null })).not.toBe("covered");
  });

  test("signing: a configured signer that never signed a checkpoint is not covered", () => {
    expect(statusOf("SOC2", "SOC2-CC6.7", { ...HEALTHY, signingActive: true, signingProven: false })).not.toBe("covered");
    expect(statusOf("EU_AI_ACT", "EUAIACT-ART12-INTEGRITY", { ...HEALTHY, signingProven: false })).toBe("partial");
  });

  test("CC6.6: a committed guardrail baseline with USING(true) RLS is partial", () => {
    expect(statusOf("SOC2", "SOC2-CC6.6", { ...HEALTHY, dbRlsEnforced: false })).toBe("partial");
    expect(statusOf("SOC2", "SOC2-CC6.6", { ...HEALTHY, dbRlsEnforced: null })).toBe("partial");
  });

  test("ISO A.9.2: capabilities set to enforce with no enforced decision is partial", () => {
    expect(statusOf("ISO42001", "ISO42001-A.9.2", { ...HEALTHY, gateEnforcedWindow: 0 })).toBe("partial");
  });

  test("NIST-MANAGE: decisions with no enforced block is partial", () => {
    expect(statusOf("NIST_AI_RMF", "NIST-MANAGE", { ...HEALTHY, gateEnforcedBlocksWindow: 0 })).toBe("partial");
  });

  test("EU ART14: human oversight needs an enforced escalation, not a would-block", () => {
    expect(statusOf("EU_AI_ACT", "EUAIACT-ART14", { ...HEALTHY, gateEnforcedEscalationsWindow: 0 })).toBe("partial");
    expect(statusOf("EU_AI_ACT", "EUAIACT-ART14", { ...HEALTHY, gateEnforcedEscalationsWindow: 0, gateWouldBlockWindow: 0 })).toBe("gap");
  });

  test("the vacuous fixture's coverage collapses relative to healthy", () => {
    for (const fw of ALL_FRAMEWORKS) {
      expect(generateReport(fw, VACUOUS).coverage).toBeLessThan(generateReport(fw, HEALTHY).coverage);
    }
  });
});
