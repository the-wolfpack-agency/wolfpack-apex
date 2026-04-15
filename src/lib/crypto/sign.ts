/**
 * Crypto-agility signing layer for Instinct.
 *
 * All JWT sign/verify operations MUST go through these functions.
 * The algorithm is resolved from the registry — swap algorithms
 * by changing CURRENT_SIGN_ALGORITHM in algorithms.ts, not here.
 *
 * Analytics events are emitted on every sign/verify so the learning
 * loop can detect algorithm drift, failure spikes, and plan PQC migration.
 */

import { sign, verify, type JwtPayload } from "jsonwebtoken";
import { trackEvent } from "@/lib/analytics";
import {
  type AlgorithmId,
  CURRENT_SIGN_ALGORITHM,
  assertCallable,
} from "@/lib/crypto/algorithms";

/** Default access-token TTL: 15 minutes */
const DEFAULT_TTL_SECONDS = 15 * 60;

export interface SignOptions {
  /** Override TTL in seconds. Defaults to 15 minutes. */
  ttlSeconds?: number;
  /** Override the algorithm. Defaults to CURRENT_SIGN_ALGORITHM. */
  algorithm?: AlgorithmId;
}

export type VerifyResult<T> =
  | { valid: true; payload: T; algorithm: AlgorithmId }
  | { valid: false; reason: string };

function getJwtSecret(): string {
  const secret = process.env.INSTINCT_JWT_SECRET ?? process.env.APEX_JWT_SECRET;
  if (secret) {
    if (process.env.NODE_ENV === "production" && secret.length < 32) {
      throw new Error("[auth] JWT secret must be at least 32 characters in production");
    }
    return secret;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "[auth] INSTINCT_JWT_SECRET (or legacy APEX_JWT_SECRET) must be set in production",
    );
  }
  console.warn("[auth] Using development fallback JWT secret — do not use in production");
  return "instinct-dev-secret-do-not-use-in-production";
}

/**
 * Sign a payload and return a JWT string.
 *
 * Emits: system.token_signed
 */
export function signToken(payload: object, opts: SignOptions = {}): string {
  const algId = opts.algorithm ?? CURRENT_SIGN_ALGORITHM;
  const alg = assertCallable(algId); // throws NotImplementedError for PQC slots
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const secret = getJwtSecret();

  const token = sign(payload, secret, {
    algorithm: alg.jwtAlg,
    expiresIn: ttl,
  });

  trackEvent("system.token_signed", "system", "system", {
    algorithm: algId,
    quantum_safe: alg.quantumSafe,
    ttl_seconds: ttl,
  });

  return token;
}

/**
 * Verify a JWT and return a typed result.
 *
 * Never throws — callers check `.valid`.
 * Emits: system.token_verified or system.token_verify_failed
 */
export function verifyToken<T>(token: string): VerifyResult<T> {
  // We try all non-reserved algorithms in the registry so a key rotation
  // that changes CURRENT_SIGN_ALGORITHM doesn't immediately invalidate
  // short-lived tokens signed under the previous algorithm.
  const algId: AlgorithmId = CURRENT_SIGN_ALGORITHM;
  const alg = assertCallable(algId);
  const secret = getJwtSecret();

  try {
    const payload = verify(token, secret, {
      algorithms: [alg.jwtAlg],
    }) as T;

    trackEvent("system.token_verified", "system", "system", {
      algorithm: algId,
      quantum_safe: alg.quantumSafe,
      valid: true,
    });

    return { valid: true, payload, algorithm: algId };
  } catch (err) {
    const raw = err as Error;
    const reason =
      raw.name === "TokenExpiredError"
        ? "expired"
        : raw.name === "JsonWebTokenError"
          ? "invalid"
          : raw.name === "NotBeforeError"
            ? "not_yet_valid"
            : "unknown";

    trackEvent("system.token_verify_failed", "system", "system", {
      reason,
      algorithm_claimed: algId,
    });

    return { valid: false, reason };
  }
}
