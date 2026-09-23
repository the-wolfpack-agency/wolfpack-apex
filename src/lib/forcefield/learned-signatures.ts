/**
 * Learned hostile-tradecraft signatures - the collect -> learn -> detect-faster loop.
 *
 * The static MALICIOUS_COMBINATIONS catalog (agent-tool-composition.ts) only
 * knows the combos we hand-coded. This module LEARNS new ones from the operators
 * we have already caught: it mines the recurring tradecraft tell-combinations out
 * of hostile dossiers, persists each as a signature, and matches new operators
 * against them - so a brand-new agent that behaves like prior hostiles is caught
 * by its METHODS, before it trips a honeytoken.
 *
 * Enforcement is EARNED, not assumed (best practice: shadow, then enforce):
 *   - Proof (a honeytoken trip / live payload) still auto-blocks instantly
 *     elsewhere; that path is unchanged and unforgeable.
 *   - A LEARNED signature starts in shadow (records would-block only). It
 *     auto-promotes to enforcing ONLY once it has been exhibited by >= MIN_
 *     PREVALENCE distinct caught hostiles, is built from dangerous-tier tradecraft,
 *     has been matched by >= MIN_SHADOW_MATCHES live operators, and has logged
 *     ZERO false positives against welcomed/known-good agents. Then it auto-blocks
 *     via the SAME distributed block list the honeytoken flywheel uses.
 *
 * Pure core (mineSignatures / matchOperator / signatureHash) is I/O-free and
 * unit-testable; evaluateLearnedSignatures takes injected deps. Fail-safe: the
 * live path never throws into its caller (the cron).
 */
import { createHash } from "node:crypto";

/** Tells strong enough to justify acting on (not weak recon/UA hints). A learned
 *  signature may only ever enforce if its combo includes at least one of these -
 *  so a benign crawler's tell-set can never become an enforcing signature. */
export const DANGEROUS_TELLS: ReadonlySet<string> = new Set([
  "payload_attack",
  "tripped_decoy",
  "id_enumeration",
  "injection",
  "deliberate_violation",
  "impersonation",
  "mandate_exceeded",
  "sqlmap",
  "form_spammer",
]);

/** Promotion gate (shadow -> enforcing). Deliberately conservative. */
export const MIN_PREVALENCE = 3; // distinct caught hostiles that share the combo
export const MIN_SHADOW_MATCHES = 2; // live operators the combo matched while shadow
export const MIN_TELLS = 2; // a combo of one tell is not a signature

export interface OperatorDossierLite {
  operatorKey: string;
  threatLevel: "benign" | "elevated" | "hostile";
  /** Whether this operator is on the welcome lane / identified good agent. Such a
   *  match is a FALSE POSITIVE and permanently blocks the signature's promotion. */
  welcomed?: boolean;
  tells: string[];
}

export interface MinedSignature {
  sigHash: string;
  tells: string[];
  dangerous: boolean;
  /** Distinct caught hostiles whose tells are a superset of this combo. */
  prevalence: number;
}

/** Canonical, order-independent hash of a tell-combination. */
export function signatureHash(tells: readonly string[]): string {
  const canon = Array.from(new Set(tells)).sort();
  return createHash("sha256").update(canon.join("|")).digest("hex").slice(0, 24);
}

/** True when an operator exhibits a signature: its tells are a superset of the
 *  signature's combo (which must be >= MIN_TELLS long). Mirrors the reputation
 *  network's subset-match, so the same actor's methods recognize across sites. */
export function matchOperator(operatorTells: readonly string[], signatureTells: readonly string[]): boolean {
  if (signatureTells.length < MIN_TELLS) return false;
  const have = new Set(operatorTells);
  return signatureTells.every((t) => have.has(t));
}

/**
 * Mine candidate signatures from caught hostiles. Each hostile operator's own
 * tell-set is a candidate combo; prevalence is the number of DISTINCT hostiles
 * whose tells are a superset of that combo (so a combo two different actors share
 * counts twice). Candidate count is bounded by the number of hostile operators,
 * never combinatorial. Only combos of >= MIN_TELLS are considered.
 */
export function mineSignatures(dossiers: readonly OperatorDossierLite[]): MinedSignature[] {
  const hostiles = dossiers.filter((d) => d.threatLevel === "hostile" && d.tells.length >= MIN_TELLS);
  if (hostiles.length === 0) return [];

  // Distinct candidate combos, keyed by canonical hash.
  const candidates = new Map<string, string[]>();
  for (const h of hostiles) {
    const combo = Array.from(new Set(h.tells)).sort();
    candidates.set(signatureHash(combo), combo);
  }

  const out: MinedSignature[] = [];
  for (const [sigHash, combo] of candidates) {
    // Prevalence: distinct hostiles whose tells contain the whole combo.
    let prevalence = 0;
    for (const h of hostiles) if (matchOperator(h.tells, combo)) prevalence++;
    out.push({ sigHash, tells: combo, dangerous: combo.some((t) => DANGEROUS_TELLS.has(t)), prevalence });
  }
  return out.sort((a, b) => b.prevalence - a.prevalence);
}

/** A persisted signature as the evaluator reads it back. */
export interface StoredSignature {
  sigHash: string;
  tells: string[];
  dangerous: boolean;
  prevalence: number;
  status: "shadow" | "enforcing" | "retired";
  shadowMatches: number;
  falsePositiveHits: number;
}

export interface LearnedSignatureDeps {
  /** All operator dossiers in range (hostile + elevated + benign), for mining and matching. */
  listDossiers: () => Promise<OperatorDossierLite[]>;
  /** Upsert a mined signature (insert new, or bump prevalence/dangerous on existing). */
  upsertSignature: (sig: MinedSignature) => Promise<void>;
  /** Read back the current stored signatures (non-retired). */
  listSignatures: () => Promise<StoredSignature[]>;
  /** A shadow signature matched a live hostile/elevated operator. */
  recordShadowMatch: (sigHash: string) => Promise<void>;
  /** A signature matched a welcomed/known-good operator - a false positive. */
  recordFalsePositive: (sigHash: string) => Promise<void>;
  /** Flip a signature shadow -> enforcing. */
  promoteSignature: (sigHash: string) => Promise<void>;
  /** Auto-block a matched operator (resolve its edge fps into the distributed
   *  block list under an auto:<reason> key). Returns fps blocked. */
  autoBlockOperator: (operatorKey: string, reason: string) => Promise<number>;
  track: (event: "forcefield.signature_mined" | "forcefield.signature_promoted" | "forcefield.signature_autoblocked", payload: Record<string, string | number | boolean>) => void;
}

export interface LearnedSignatureReport {
  mined: number;
  shadow: number;
  enforcing: number;
  promoted: number;
  operatorsAutoBlocked: number;
  falsePositives: number;
}

/** True when a shadow signature has earned enforcement. */
export function eligibleForPromotion(sig: StoredSignature): boolean {
  return (
    sig.status === "shadow" &&
    sig.dangerous &&
    sig.prevalence >= MIN_PREVALENCE &&
    sig.shadowMatches >= MIN_SHADOW_MATCHES &&
    sig.falsePositiveHits === 0
  );
}

/**
 * One learning pass: mine from caught hostiles, match live operators against the
 * stored signatures, count shadow matches / false positives, auto-block on
 * enforcing matches, and promote any shadow signature that has earned it.
 * Never throws (best-effort; the cron gets a report or a degraded one).
 */
export async function evaluateLearnedSignatures(deps: LearnedSignatureDeps): Promise<LearnedSignatureReport> {
  const report: LearnedSignatureReport = { mined: 0, shadow: 0, enforcing: 0, promoted: 0, operatorsAutoBlocked: 0, falsePositives: 0 };
  let dossiers: OperatorDossierLite[] = [];
  try {
    dossiers = await deps.listDossiers();
  } catch {
    return report;
  }

  // 1. Mine + persist candidate signatures from caught hostiles.
  const mined = mineSignatures(dossiers);
  report.mined = mined.length;
  for (const sig of mined) {
    await deps.upsertSignature(sig).catch(() => {});
  }
  if (mined.length) deps.track("forcefield.signature_mined", { count: mined.length, dangerous: mined.filter((s) => s.dangerous).length });

  // 2. Match live operators against stored signatures.
  const signatures = await deps.listSignatures().catch(() => [] as StoredSignature[]);
  for (const sig of signatures) {
    if (sig.status === "enforcing") report.enforcing++;
    else if (sig.status === "shadow") report.shadow++;
  }

  for (const op of dossiers) {
    for (const sig of signatures) {
      if (sig.status === "retired") continue;
      if (!matchOperator(op.tells, sig.tells)) continue;

      const isGood = op.welcomed === true || op.threatLevel === "benign";
      if (isGood) {
        // A good agent matching a hostile combo is a false positive - it must
        // never block, and it permanently disqualifies the signature.
        report.falsePositives++;
        await deps.recordFalsePositive(sig.sigHash).catch(() => {});
        continue;
      }

      // Hostile / elevated operator.
      if (sig.status === "enforcing") {
        const n = await deps.autoBlockOperator(op.operatorKey, `learned:${sig.sigHash.slice(0, 8)}`).catch(() => 0);
        if (n > 0) {
          report.operatorsAutoBlocked++;
          deps.track("forcefield.signature_autoblocked", { sigHash: sig.sigHash, operatorKey: op.operatorKey, fps: n });
        }
      } else {
        await deps.recordShadowMatch(sig.sigHash).catch(() => {});
      }
    }
  }

  // 3. Promote shadow signatures that have earned enforcement. Re-read so the
  //    shadow-match/false-positive counters written above are reflected.
  const refreshed = await deps.listSignatures().catch(() => signatures);
  for (const sig of refreshed) {
    if (eligibleForPromotion(sig)) {
      await deps.promoteSignature(sig.sigHash).catch(() => {});
      report.promoted++;
      deps.track("forcefield.signature_promoted", { sigHash: sig.sigHash, prevalence: sig.prevalence, tells: sig.tells.join(",") });
    }
  }

  return report;
}
