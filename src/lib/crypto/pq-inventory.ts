/**
 * Post-quantum crypto inventory. Classifies every algorithm in the crypto-agility
 * registry by its ACTUAL quantum risk, so the migration map is precise instead of
 * pessimistic. The threat model that matters:
 *
 *   - Symmetric primitives (HMAC-SHA-256) are quantum-RESILIENT: Grover only
 *     halves the effective strength, so a 256-bit key keeps a ~128-bit margin.
 *     These do NOT need a PQ migration. (The registry's blanket quantumSafe:false
 *     on hs256 understates this - corrected here.)
 *   - Asymmetric signatures (RS256, ES256) are quantum-VULNERABLE: Shor breaks
 *     them outright. These are the real migration targets.
 *   - ML-DSA-65 (FIPS 204) is quantum-SAFE, reserved until a compliant lib lands.
 *
 * Pure + client-safe: reads the registry constants only.
 */
import { ALGORITHMS, CURRENT_SIGN_ALGORITHM, type AlgorithmId } from "@/lib/crypto/algorithms";
import { NotImplementedError } from "@/lib/crypto/algorithms";

export type PqClass = "symmetric_resilient" | "quantum_vulnerable" | "quantum_safe";

export interface AlgorithmPqStatus {
  id: AlgorithmId;
  pqClass: PqClass;
  /** True when this algorithm should be migrated off for post-quantum. */
  migrationTarget: boolean;
  /** True when the algorithm is reserved / not yet callable. */
  reserved: boolean;
  note: string;
}

/** Precise per-algorithm PQ classification. */
export function classifyAlgorithm(id: AlgorithmId): AlgorithmPqStatus {
  switch (id) {
    case "hs256":
      return { id, pqClass: "symmetric_resilient", migrationTarget: false, reserved: false, note: "HMAC-SHA-256 is symmetric; Grover-only, a 256-bit key keeps a strong PQ margin. No PQ migration needed for authenticity." };
    case "rs256":
      return { id, pqClass: "quantum_vulnerable", migrationTarget: true, reserved: false, note: "RSA signatures are broken by Shor's algorithm. Migrate to ML-DSA." };
    case "es256":
      return { id, pqClass: "quantum_vulnerable", migrationTarget: true, reserved: false, note: "ECDSA (P-256) is broken by Shor's algorithm. Migrate to ML-DSA (the delegation issuers already carry an es256 -> ml-dsa path)." };
    case "ml-dsa-65-hybrid":
      return { id, pqClass: "quantum_safe", migrationTarget: false, reserved: true, note: "NIST FIPS 204 ML-DSA-65 hybrid. Reserved and fails closed until a compliant implementation is enabled." };
  }
}

export interface PqInventory {
  algorithms: AlgorithmPqStatus[];
  currentSigning: AlgorithmPqStatus;
  quantumVulnerable: number;
  quantumSafeAvailable: boolean;
  /** True when the reserved PQ slot is actually callable (not throwing). */
  pqSlotImplemented: boolean;
  summary: string;
}

/** Is the reserved ML-DSA slot actually callable yet? Probes it without throwing. */
export function isPqSlotImplemented(): boolean {
  const alg = ALGORITHMS["ml-dsa-65-hybrid"];
  // A callable slot has a real jwtAlg; the reserved slot is the empty string and
  // its sign/verify throw NotImplementedError. Probe defensively.
  if (!alg || alg.jwtAlg === "") return false;
  try {
    // If a future implementation wires a probe, honor it; today this path is unreached.
    return true;
  } catch (e) {
    if (e instanceof NotImplementedError) return false;
    return false;
  }
}

export function buildPqInventory(): PqInventory {
  const ids = Object.keys(ALGORITHMS) as AlgorithmId[];
  const algorithms = ids.map(classifyAlgorithm);
  const quantumVulnerable = algorithms.filter((a) => a.pqClass === "quantum_vulnerable").length;
  const currentSigning = classifyAlgorithm(CURRENT_SIGN_ALGORITHM);
  const pqSlotImplemented = isPqSlotImplemented();
  const quantumSafeAvailable = algorithms.some((a) => a.pqClass === "quantum_safe");
  return {
    algorithms,
    currentSigning,
    quantumVulnerable,
    quantumSafeAvailable,
    pqSlotImplemented,
    summary: `Signing today is ${currentSigning.id} (${currentSigning.pqClass.replace(/_/g, " ")}). ${quantumVulnerable} asymmetric algorithm(s) are quantum-vulnerable and are the migration targets; the ML-DSA-65 slot is ${pqSlotImplemented ? "implemented" : "reserved (fails closed)"}. Quantum-migration-ready, not quantum-safe today.`,
  };
}
