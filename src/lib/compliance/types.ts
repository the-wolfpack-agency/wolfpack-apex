/**
 * Compliance engine — types.
 *
 * The product can deep-test a platform AND govern its AI, so compliance evidence
 * should not be a manual binder: it should be generated from what the system
 * already proves. This engine crosswalks OGIAM's live controls (the gate, the
 * tamper-evident ledger, agent IAM, continuous red-team, shadow-AI discovery) to
 * the controls of the major frameworks, derives a covered/partial/gap status from
 * REAL evidence (chain verified, decisions recorded, red-team pass rate, the
 * ungoverned-AI gap), and produces a report a CISO or auditor can act on.
 *
 * The crosswalk is deliberately HONEST: representative controls, status derived
 * from measured evidence, never a blanket "compliant" claim.
 */

export type ComplianceFramework = "SOC2" | "ISO42001" | "NIST_AI_RMF" | "EU_AI_ACT";

export type ControlStatus = "covered" | "partial" | "gap";

/** The measured evidence the engine derives every control status from. Collected
 *  from the live stores (audit ledger, gate decisions, red-team, AI inventory,
 *  enforcement posture) - no data invented. */
export interface EvidenceInputs {
  /** The audit ledger's hash chain verified end to end. */
  auditChainValid: boolean;
  auditEntries: number;
  /** Total gate decisions recorded (the AI-action system of record). */
  gateDecisions: number;
  /** Decisions the gate would block (deny/escalate). */
  gateWouldBlock: number;
  /** Capabilities graduated to enforce (vs monitor-only). */
  enforceCapabilities: number;
  /** Latest continuous red-team pass rate (0..1), or null if never run. */
  redteamPassRate: number | null;
  /** A red-team run happened recently enough to count as continuous. */
  redteamRecent: boolean;
  /** Discovered AI touchpoints and how many are ungoverned. */
  aiSurfacesTotal: number;
  ungovernedAiSurfaces: number;
  /** A real (non-null) signer is active, so the ledger + evidence exports are
   *  cryptographically signed and independently verifiable (data-protection). */
  signingActive: boolean;
  /** The signing algorithm in force (ES256 via Key Vault in prod, HS256-local in
   *  dev, "none" when no signer is configured). */
  signingAlgorithm: string;
  /** At-rest secret encryption is operational (an encrypt/decrypt probe round-
   *  trips and the ciphertext differs from the plaintext). */
  secretsEncryptedAtRest: boolean;
  /** Repo-wide tenant-isolation guardrail: every workspace-scoped query is
   *  classified (0 unclassified) as of the last CI-verified scan. */
  tenantIsolationEnforced: boolean;
  /** Count of workspace-scoped tables under the guardrail. */
  tenantScopedTables: number;
}

/** One framework control mapped to an OGIAM capability + an evidence-driven
 *  status. Pure functions so the report is reproducible. */
export interface ComplianceControl {
  id: string;
  name: string;
  /** The OGIAM capability that satisfies this control. */
  ogiamControl: string;
  rationale: string;
  status(e: EvidenceInputs): ControlStatus;
  evidence(e: EvidenceInputs): string;
}

export interface ControlResult {
  id: string;
  name: string;
  ogiamControl: string;
  rationale: string;
  status: ControlStatus;
  evidence: string;
}

export interface ComplianceReport {
  framework: ComplianceFramework;
  generatedNote: string;
  controls: ControlResult[];
  covered: number;
  partial: number;
  gap: number;
  /** covered / total, 0..1. */
  coverage: number;
}
