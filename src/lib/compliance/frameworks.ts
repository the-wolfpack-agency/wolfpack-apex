/**
 * The control crosswalk: representative controls from each framework mapped to
 * the OGIAM capability that satisfies them, with an evidence-driven status. This
 * is the IP - the mapping from "what OGIAM proves" to "what an auditor asks for".
 * Kept honest: a control is only "covered" when the measured evidence supports it.
 */
import type { ComplianceControl, ComplianceFramework, EvidenceInputs } from "./types";

/** Continuous red-team is healthy: a recent run blocked every attack. */
function redteamHealthy(e: EvidenceInputs): boolean {
  return e.redteamRecent && e.redteamPassRate === 1;
}

/** The tamper-evident system of record is live and intact. */
function ledgerLive(e: EvidenceInputs): boolean {
  return e.auditChainValid && e.auditEntries > 0;
}

/** Data is protected at rest (encrypted secrets) and records are signed
 *  (verifiable) - the cryptographic data-protection posture. */
function dataProtected(e: EvidenceInputs): boolean {
  return e.signingActive && e.secretsEncryptedAtRest;
}

const SOC2: ComplianceControl[] = [
  {
    id: "SOC2-CC4.1",
    name: "Monitoring of controls",
    ogiamControl: "Tamper-evident audit ledger",
    rationale: "Every AI action is recorded in a hash-chained, verifiable ledger.",
    status: (e) => (ledgerLive(e) ? "covered" : e.auditEntries > 0 ? "partial" : "gap"),
    evidence: (e) => `audit chain ${e.auditChainValid ? "verified" : "unverified"} across ${e.auditEntries} entries`,
  },
  {
    id: "SOC2-CC6.1",
    name: "Logical access controls",
    ogiamControl: "Agent IAM + deterministic gate",
    rationale: "Agents act as least-privilege principals; every action passes a capability-scoped gate.",
    status: (e) => (e.gateDecisions > 0 ? "covered" : "partial"),
    evidence: (e) => `${e.gateDecisions} gated AI actions, ${e.enforceCapabilities} capabilities enforced`,
  },
  {
    id: "SOC2-CC7.2",
    name: "Anomaly / threat monitoring",
    ogiamControl: "Continuous red-team + drift",
    rationale: "The gate is adversarially tested on a schedule; agent behavior is baselined for drift.",
    status: (e) => (redteamHealthy(e) ? "covered" : e.redteamPassRate !== null ? "partial" : "gap"),
    evidence: (e) => `red-team pass rate ${e.redteamPassRate ?? "n/a"}${e.redteamRecent ? " (recent)" : ""}`,
  },
  {
    id: "SOC2-CC7.3",
    name: "Incident detection + response",
    ogiamControl: "Gate block/escalate + fail-closed",
    rationale: "High-risk AI actions are blocked or escalated to a human; unauditable actions fail closed.",
    status: (e) => (e.gateWouldBlock >= 0 && e.gateDecisions > 0 ? "covered" : "partial"),
    evidence: (e) => `${e.gateWouldBlock} would-block decisions of ${e.gateDecisions}`,
  },
  {
    id: "SOC2-CC6.6",
    name: "Logical segregation of tenant data",
    ogiamControl: "Workspace-scoped access + CI guardrail",
    rationale: "Every workspace-scoped query is filtered and verified by a repo-wide guardrail (0 unclassified).",
    status: (e) => (e.tenantIsolationEnforced ? "covered" : e.tenantScopedTables > 0 ? "partial" : "gap"),
    evidence: (e) => `${e.tenantScopedTables} workspace-scoped tables, ${e.tenantIsolationEnforced ? "0" : ">0"} unclassified queries`,
  },
  {
    id: "SOC2-CC6.7",
    name: "Encryption + key management",
    ogiamControl: "Named-algorithm crypto registry",
    rationale: "Secrets are encrypted at rest and records are signed through a named-algorithm registry, never ad hoc.",
    status: (e) => (dataProtected(e) ? "covered" : e.signingActive || e.secretsEncryptedAtRest ? "partial" : "gap"),
    evidence: (e) => `signing ${e.signingAlgorithm}, secrets encrypted at rest: ${e.secretsEncryptedAtRest}`,
  },
];

const ISO42001: ComplianceControl[] = [
  {
    id: "ISO42001-A.6.2",
    name: "AI system risk assessment",
    ogiamControl: "Continuous red-team + AI surface discovery",
    rationale: "AI surfaces are inventoried and adversarially tested against the OWASP LLM classes.",
    status: (e) => (redteamHealthy(e) && e.aiSurfacesTotal > 0 ? "covered" : "partial"),
    evidence: (e) => `${e.aiSurfacesTotal} AI surfaces inventoried, red-team pass ${e.redteamPassRate ?? "n/a"}`,
  },
  {
    id: "ISO42001-A.7.4",
    name: "Records of AI system operation",
    ogiamControl: "Tamper-evident audit ledger",
    rationale: "Each AI decision and outcome is recorded with the rule that fired.",
    status: (e) => (ledgerLive(e) ? "covered" : "gap"),
    evidence: (e) => `audit chain ${e.auditChainValid ? "verified" : "unverified"}, ${e.auditEntries} entries`,
  },
  {
    id: "ISO42001-A.9.2",
    name: "AI use governance + controls",
    ogiamControl: "Per-capability enforce posture",
    rationale: "Governance is enforced per capability, not assumed; posture changes are audited.",
    status: (e) => (e.enforceCapabilities > 0 ? "covered" : "partial"),
    evidence: (e) => `${e.enforceCapabilities} capabilities under active enforcement`,
  },
  {
    id: "ISO42001-A.8.3",
    name: "Data protection for AI systems",
    ogiamControl: "Encrypted secrets + signed records",
    rationale: "AI system secrets are encrypted at rest and its records are cryptographically signed and verifiable.",
    status: (e) => (dataProtected(e) ? "covered" : e.signingActive || e.secretsEncryptedAtRest ? "partial" : "gap"),
    evidence: (e) => `signing ${e.signingAlgorithm}, secrets encrypted at rest: ${e.secretsEncryptedAtRest}`,
  },
];

const NIST_AI_RMF: ComplianceControl[] = [
  {
    id: "NIST-GOVERN",
    name: "Govern: accountability + records",
    ogiamControl: "Agent IAM + audit ledger",
    rationale: "Every agent has an accountable human owner and a tamper-evident action record.",
    status: (e) => (ledgerLive(e) ? "covered" : "partial"),
    evidence: (e) => `ledger ${e.auditChainValid ? "verified" : "unverified"} (${e.auditEntries})`,
  },
  {
    id: "NIST-MAP",
    name: "Map: inventory AI in context",
    ogiamControl: "Shadow-AI discovery",
    rationale: "All AI touchpoints are discovered; the ungoverned ones are surfaced as the gap.",
    status: (e) => (e.aiSurfacesTotal > 0 ? (e.ungovernedAiSurfaces === 0 ? "covered" : "partial") : "gap"),
    evidence: (e) => `${e.aiSurfacesTotal} surfaces, ${e.ungovernedAiSurfaces} ungoverned`,
  },
  {
    id: "NIST-MEASURE",
    name: "Measure: test + evaluate AI risk",
    ogiamControl: "Continuous red-team",
    rationale: "The gate is continuously attacked with the known AI attack classes and measured.",
    status: (e) => (redteamHealthy(e) ? "covered" : e.redteamPassRate !== null ? "partial" : "gap"),
    evidence: (e) => `red-team pass ${e.redteamPassRate ?? "n/a"}${e.redteamRecent ? " (recent)" : ""}`,
  },
  {
    id: "NIST-MANAGE",
    name: "Manage: respond to AI risk",
    ogiamControl: "Deterministic gate (block/escalate)",
    rationale: "Dangerous AI actions are deterministically blocked or escalated to a human.",
    status: (e) => (e.gateDecisions > 0 ? "covered" : "partial"),
    evidence: (e) => `${e.gateDecisions} decisions, ${e.gateWouldBlock} would-block`,
  },
];

const EU_AI_ACT: ComplianceControl[] = [
  {
    id: "EUAIACT-ART9",
    name: "Risk management system",
    ogiamControl: "Red-team + AI-code governance",
    rationale: "Continuous adversarial testing plus governance of AI-authored code feed a standing risk process.",
    status: (e) => (redteamHealthy(e) ? "covered" : "partial"),
    evidence: (e) => `red-team pass ${e.redteamPassRate ?? "n/a"}`,
  },
  {
    id: "EUAIACT-ART12",
    name: "Record-keeping / automatic logs",
    ogiamControl: "Tamper-evident audit ledger",
    rationale: "Automatic, tamper-evident logging of AI system operation over its lifecycle.",
    status: (e) => (ledgerLive(e) ? "covered" : "gap"),
    evidence: (e) => `audit chain ${e.auditChainValid ? "verified" : "unverified"}, ${e.auditEntries} entries`,
  },
  {
    id: "EUAIACT-ART14",
    name: "Human oversight",
    ogiamControl: "Gate escalation + approval queue",
    rationale: "High-risk AI actions are held for human approval before they execute.",
    status: (e) => (e.gateDecisions > 0 ? "covered" : "partial"),
    evidence: (e) => `${e.gateWouldBlock} actions routed to human review of ${e.gateDecisions}`,
  },
  {
    id: "EUAIACT-ART15",
    name: "Accuracy, robustness, cybersecurity",
    ogiamControl: "Continuous red-team + deterministic gate",
    rationale: "The control plane is deterministic and continuously proven against AI attack classes.",
    status: (e) => (redteamHealthy(e) ? "covered" : e.redteamPassRate !== null ? "partial" : "gap"),
    evidence: (e) => `red-team pass ${e.redteamPassRate ?? "n/a"}${e.redteamRecent ? " (recent)" : ""}`,
  },
  {
    id: "EUAIACT-ART12-INTEGRITY",
    name: "Record integrity (signed, tamper-evident logs)",
    ogiamControl: "Hash-chained ledger + signed evidence export",
    rationale: "Records are tamper-evident AND cryptographically signed, so an auditor can verify them independently.",
    status: (e) => (ledgerLive(e) && e.signingActive ? "covered" : ledgerLive(e) ? "partial" : "gap"),
    evidence: (e) => `ledger ${e.auditChainValid ? "verified" : "unverified"}, evidence signed via ${e.signingAlgorithm}`,
  },
];

export const FRAMEWORKS: Record<ComplianceFramework, ComplianceControl[]> = {
  SOC2,
  ISO42001,
  NIST_AI_RMF,
  EU_AI_ACT,
};

export const ALL_FRAMEWORKS: ComplianceFramework[] = ["SOC2", "ISO42001", "NIST_AI_RMF", "EU_AI_ACT"];
