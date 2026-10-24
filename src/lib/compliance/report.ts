/**
 * Pure report generator: apply a framework's controls to measured evidence and
 * roll up coverage. Reproducible (no IO), so the same evidence always yields the
 * same report - which is what makes it auditable.
 */
import { FRAMEWORKS } from "./frameworks";
import type { ComplianceFramework, ComplianceReport, ControlResult, EvidenceInputs } from "./types";

export function generateReport(framework: ComplianceFramework, evidence: EvidenceInputs): ComplianceReport {
  const controls = FRAMEWORKS[framework];
  const results: ControlResult[] = controls.map((c) => ({
    id: c.id,
    name: c.name,
    ogiamControl: c.ogiamControl,
    rationale: c.rationale,
    status: c.status(evidence),
    evidence: c.evidence(evidence),
  }));
  const covered = results.filter((r) => r.status === "covered").length;
  const partial = results.filter((r) => r.status === "partial").length;
  const gap = results.filter((r) => r.status === "gap").length;
  return {
    framework,
    generatedNote:
      "Status is derived from execution evidence inside a window (enforced gate decisions, a verified audit chain, signed checkpoints, plaintext-secret counts, database RLS). Configuration alone never reads covered, and the fixed gate regression set is not red-team coverage. Representative controls; not a blanket compliance attestation.",
    controls: results,
    covered,
    partial,
    gap,
    coverage: results.length === 0 ? 0 : covered / results.length,
  };
}
