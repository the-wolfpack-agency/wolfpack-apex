/**
 * Crypto-agility algorithm registry for Instinct.
 *
 * Every signing/verifying operation must go through this registry.
 * Adding post-quantum support is a single registry entry — no call-site refactor.
 *
 * Current: hs256 (HMAC-SHA-256) — symmetric, matches the existing INSTINCT_JWT_SECRET.
 * Reserved: ml-dsa-65-hybrid — NIST FIPS 204 post-quantum slot; throws NotImplementedError
 *   until a compliant implementation is available (expected 2027-2030 NIST timeline).
 */

import type { Algorithm } from "jsonwebtoken";

export type AlgorithmId = "hs256" | "rs256" | "es256" | "ml-dsa-65-hybrid";

export interface SignAlgorithm {
  /** Registry key */
  id: AlgorithmId;
  /** Maps to jsonwebtoken's Algorithm type. Empty string for reserved/unimplemented algorithms. */
  jwtAlg: Algorithm | "";
  /** Whether this algorithm is considered quantum-safe */
  quantumSafe: boolean;
  /** Mark older algorithms deprecated so consumers can warn/migrate */
  deprecated?: boolean;
}

export const ALGORITHMS: Record<AlgorithmId, SignAlgorithm> = {
  hs256: {
    id: "hs256",
    jwtAlg: "HS256",
    quantumSafe: false,
    deprecated: false,
  },
  rs256: {
    id: "rs256",
    jwtAlg: "RS256",
    quantumSafe: false,
    deprecated: false,
  },
  es256: {
    id: "es256",
    jwtAlg: "ES256",
    quantumSafe: false,
    deprecated: false,
  },
  /**
   * RESERVED: NIST ML-DSA-65 (FIPS 204) hybrid slot.
   *
   * Invoking this algorithm throws NotImplementedError — intentionally.
   * The slot exists so the migration from classical algorithms to
   * post-quantum is a single registry edit, not a codebase refactor.
   * Expected to be implementable ~2027-2030 when compliant JS libraries
   * stabilise after the NIST FIPS 204 final standard.
   */
  "ml-dsa-65-hybrid": {
    id: "ml-dsa-65-hybrid",
    jwtAlg: "",
    quantumSafe: true,
    deprecated: false,
  },
};

/**
 * The algorithm used for all new token signing.
 * Change this single line to migrate the entire platform.
 */
export const CURRENT_SIGN_ALGORITHM: AlgorithmId = "hs256";

/**
 * Thrown when an algorithm slot is reserved but not yet implemented
 * (e.g., the ml-dsa-65-hybrid PQC slot).
 */
export class NotImplementedError extends Error {
  constructor(algorithmId: AlgorithmId) {
    super(
      `[crypto] Algorithm "${algorithmId}" is reserved for future post-quantum migration ` +
        `(NIST FIPS 204 / ML-DSA-65). It is not yet implemented. ` +
        `To migrate, provide a compliant implementation and update ALGORITHMS["${algorithmId}"].jwtAlg.`,
    );
    this.name = "NotImplementedError";
  }
}

/**
 * Look up a registered algorithm or throw if unknown.
 */
export function getAlgorithm(id: AlgorithmId): SignAlgorithm {
  const alg = ALGORITHMS[id];
  if (!alg) {
    throw new Error(`[crypto] Unknown algorithm id: "${id}"`);
  }
  return alg;
}

/**
 * Assert an algorithm is callable (has a real jwtAlg). Throws NotImplementedError
 * for reserved PQC slots and a generic Error for unknown IDs.
 */
export function assertCallable(id: AlgorithmId): SignAlgorithm & { jwtAlg: Algorithm } {
  const alg = getAlgorithm(id);
  if (!alg.jwtAlg) {
    throw new NotImplementedError(id);
  }
  return alg as SignAlgorithm & { jwtAlg: Algorithm };
}
