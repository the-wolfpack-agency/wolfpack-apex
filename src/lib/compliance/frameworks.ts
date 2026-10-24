/**
 * The control crosswalk: representative controls from each framework mapped to
 * the OGIAM capability that satisfies them, with an evidence-driven status.
 *
 * The rule every status function follows: "covered" requires evidence that the
 * control EXECUTED inside a window (enforced decisions, signed checkpoints, a
 * verified chain, no plaintext secrets at rest). A configuration flag, a lifetime
 * count, or a monitor-only decision stream is at most "partial". A fixed
 * regression set is never adversarial-testing coverage. Each control has a
 * regression test with a fixture that used to pass vacuously and must not.
 */
import type { ComplianceControl, ComplianceFramework, EvidenceInputs } from "./types";

/** The red-team ran recently. Says nothing about coverage. */
function redteamRanRecently(e: EvidenceInputs): boolean {
  return e.redteamRecent && e.redteamPassRate !== null;
}

/** Adversarial testing coverage: only a LIVE adversarial run, recent and clean,
 *  counts. The fixed regression set (8 literals through decide()) never does. */
function adversarialCoverage(e: EvidenceInputs): boolean {
  return e.redteamKind === "live_adversarial" && e.redteamRecent && e.redteamPassRate === 1;
}

/** Status for a control backed by the red-team: covered only with live
 *  adversarial coverage; a recent fixed-regression run is partial; else gap. */
function redteamStatus(e: EvidenceInputs) {
  return adversarialCoverage(e) ? "covered" : redteamRanRecently(e) ? "partial" : "gap";
}

function redteamEvidence(e: EvidenceInputs): string {
  if (e.redteamPassRate === null) return "no red-team run recorded";
  const what = e.redteamKind === "live_adversarial" ? "live adversarial run" : `fixed regression set, ${e.redteamCases ?? "?"} cases (not red-team coverage)`;
  return `${what}: pass rate ${e.redteamPassRate}, last run ${e.redteamLastRunAt?.slice(0, 10) ?? "unknown"}${e.redteamRecent ? "" : " (stale, older than 7d)"}`;
}

/** The tamper-evident system of record is live and intact (verified in this
 *  request by walking the chain). */
function ledgerLive(e: EvidenceInputs): boolean {
  return e.auditChainValid && e.auditEntries > 0;
}

/** Data protection: records actually signed in the window AND secrets actually
 *  encrypted at rest (no plaintext stored, real key). */
function dataProtected(e: EvidenceInputs): boolean {
  return e.signingActive && e.signingProven && secretsProtected(e);
}

/** Secrets are protected at rest only when nothing stored is plaintext and the
 *  key is not the development literal - re-checked here, not trusted from the
 *  collector's flag alone. */
function secretsProtected(e: EvidenceInputs): boolean {
  return e.secretsEncryptedAtRest && e.kekSource !== "dev-literal" && e.storedOauthPlaintext === 0 && e.storedConnectorPlaintext === 0;
}

function dataProtectionEvidence(e: EvidenceInputs): string {
  const oauth = e.storedOauthPlaintext === null ? "unknown" : String(e.storedOauthPlaintext);
  return `checkpoints signed in window: ${e.signingProven} (signer ${e.signingAlgorithm}); plaintext OAuth tokens stored: ${oauth}; at-rest key: ${e.kekSource}`;
}

/** Enforcement that ran: enforced decisions in the window, under an enforce
 *  posture. Monitor-only traffic is not access control. */
function enforcementRan(e: EvidenceInputs): boolean {
  return e.gateWindowMeasured && e.gateEnforcedWindow > 0;
}

function gateEvidence(e: EvidenceInputs): string {
  if (!e.gateWindowMeasured) return "gate decisions could not be measured";
  return `${e.gateDecisionsWindow} decisions in ${e.gateWindowDays}d: ${e.gateEnforcedWindow} enforced, ${e.gateEnforcedBlocksWindow} enforced deny/escalate, ${e.gateWouldBlockWindow} would-block`;
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
    status: (e) =>
      e.enforceCapabilities > 0 && enforcementRan(e) ? "covered" : e.gateWindowMeasured && e.gateDecisionsWindow > 0 ? "partial" : "gap",
    evidence: (e) => `${gateEvidence(e)}; ${e.enforceCapabilities} capabilities set to enforce`,
  },
  {
    id: "SOC2-CC7.2",
    name: "Anomaly / threat monitoring",
    ogiamControl: "Scheduled gate regression set + drift",
    rationale: "The gate is tested on a schedule; only a live adversarial run counts as threat-testing coverage.",
    status: redteamStatus,
    evidence: redteamEvidence,
  },
  {
    id: "SOC2-CC7.3",
    name: "Incident detection + response",
    ogiamControl: "Gate block/escalate + fail-closed",
    rationale: "High-risk AI actions are blocked or escalated to a human; unauditable actions fail closed.",
    status: (e) =>
      e.gateWindowMeasured && e.gateEnforcedBlocksWindow > 0 ? "covered" : e.gateWindowMeasured && e.gateWouldBlockWindow > 0 ? "partial" : "gap",
    evidence: gateEvidence,
  },
  {
    id: "SOC2-CC6.6",
    name: "Logical segregation of tenant data",
    ogiamControl: "Workspace-scoped access + CI guardrail",
    rationale: "Every workspace-scoped query carries a workspace predicate (repo-wide guardrail); covered requires database-level RLS the app role cannot bypass.",
    status: (e) =>
      e.tenantIsolationEnforced && e.dbRlsEnforced === true ? "covered" : e.tenantIsolationEnforced ? "partial" : "gap",
    evidence: (e) =>
      `${e.tenantScopedTables} workspace-scoped tables, ${e.tenantIsolationEnforced ? "0" : ">0"} unclassified queries; database RLS enforced: ${e.dbRlsEnforced === null ? "unknown" : e.dbRlsEnforced}`,
  },
  {
    id: "SOC2-CC6.7",
    name: "Encryption + key management",
    ogiamControl: "Named-algorithm crypto registry",
    rationale: "Secrets are encrypted at rest and records are signed through a named-algorithm registry, never ad hoc.",
    status: (e) => (dataProtected(e) ? "covered" : e.signingProven || secretsProtected(e) ? "partial" : "gap"),
    evidence: dataProtectionEvidence,
  },
];

const ISO42001: ComplianceControl[] = [
  {
    id: "ISO42001-A.6.2",
    name: "AI system risk assessment",
    ogiamControl: "Gate regression set + AI surface discovery",
    rationale: "AI surfaces are inventoried; covered requires live adversarial testing against the OWASP LLM classes.",
    status: (e) => (adversarialCoverage(e) && e.aiSurfacesTotal > 0 ? "covered" : e.aiSurfacesTotal > 0 || redteamRanRecently(e) ? "partial" : "gap"),
    evidence: (e) => `${e.aiSurfacesTotal} AI surfaces inventoried; ${redteamEvidence(e)}`,
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
    status: (e) =>
      e.enforceCapabilities > 0 && enforcementRan(e) ? "covered" : e.enforceCapabilities > 0 || (e.gateWindowMeasured && e.gateDecisionsWindow > 0) ? "partial" : "gap",
    evidence: (e) => `${e.enforceCapabilities} capabilities set to enforce; ${gateEvidence(e)}`,
  },
  {
    id: "ISO42001-A.8.3",
    name: "Data protection for AI systems",
    ogiamControl: "Encrypted secrets + signed records",
    rationale: "AI system secrets are encrypted at rest and its records are cryptographically signed and verifiable.",
    status: (e) => (dataProtected(e) ? "covered" : e.signingProven || secretsProtected(e) ? "partial" : "gap"),
    evidence: dataProtectionEvidence,
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
    ogiamControl: "Gate regression set (live adversarial pending)",
    rationale: "The gate is measured on a schedule; covered requires live adversarial testing, not a fixed regression set.",
    status: redteamStatus,
    evidence: redteamEvidence,
  },
  {
    id: "NIST-MANAGE",
    name: "Manage: respond to AI risk",
    ogiamControl: "Deterministic gate (block/escalate)",
    rationale: "Dangerous AI actions are deterministically blocked or escalated to a human.",
    status: (e) =>
      e.gateWindowMeasured && e.gateEnforcedBlocksWindow > 0 ? "covered" : e.gateWindowMeasured && e.gateDecisionsWindow > 0 ? "partial" : "gap",
    evidence: gateEvidence,
  },
];

const EU_AI_ACT: ComplianceControl[] = [
  {
    id: "EUAIACT-ART9",
    name: "Risk management system",
    ogiamControl: "Gate regression set + AI-code governance",
    rationale: "Scheduled gate regression checks plus governance of AI-authored code feed a standing risk process; covered requires live adversarial testing.",
    status: redteamStatus,
    evidence: redteamEvidence,
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
    status: (e) =>
      e.gateWindowMeasured && e.gateEnforcedEscalationsWindow > 0 ? "covered" : e.gateWindowMeasured && e.gateWouldBlockWindow > 0 ? "partial" : "gap",
    evidence: (e) =>
      e.gateWindowMeasured
        ? `${e.gateEnforcedEscalationsWindow} enforced escalations to a human in ${e.gateWindowDays}d (${e.gateWouldBlockWindow} would-block)`
        : "gate decisions could not be measured",
  },
  {
    id: "EUAIACT-ART15",
    name: "Accuracy, robustness, cybersecurity",
    ogiamControl: "Deterministic gate + gate regression set",
    rationale: "The control plane is deterministic; covered requires live adversarial testing against AI attack classes.",
    status: redteamStatus,
    evidence: redteamEvidence,
  },
  {
    id: "EUAIACT-ART12-INTEGRITY",
    name: "Record integrity (signed, tamper-evident logs)",
    ogiamControl: "Hash-chained ledger + signed evidence export",
    rationale: "Records are tamper-evident AND cryptographically signed, so an auditor can verify them independently.",
    status: (e) => (ledgerLive(e) && e.signingActive && e.signingProven ? "covered" : ledgerLive(e) ? "partial" : "gap"),
    evidence: (e) => `ledger ${e.auditChainValid ? "verified" : "unverified"}; checkpoints signed in window: ${e.signingProven} (signer ${e.signingAlgorithm})`,
  },
];

export const FRAMEWORKS: Record<ComplianceFramework, ComplianceControl[]> = {
  SOC2,
  ISO42001,
  NIST_AI_RMF,
  EU_AI_ACT,
};

export const ALL_FRAMEWORKS: ComplianceFramework[] = ["SOC2", "ISO42001", "NIST_AI_RMF", "EU_AI_ACT"];
