/**
 * GitHub App JWT minting.
 *
 * To authenticate AS a GitHub App (in order to exchange for an installation
 * token) GitHub requires a short-lived JSON Web Token signed with the App's
 * RSA private key using RS256. See:
 *   https://docs.github.com/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
 *
 * WHY node:crypto AND NOT the named-algorithm registry (src/lib/crypto):
 * --------------------------------------------------------------------------
 * Our internal session tokens go through src/lib/crypto/algorithms.ts (HS256
 * today, crypto-agile for the PQ migration). That registry governs tokens WE
 * issue and verify. THIS token is a different beast: it is consumed by an
 * EXTERNAL party (GitHub) whose protocol mandates RS256 over an RSA keypair we
 * do not control the algorithm of. We cannot swap it for HS256 or a PQ scheme
 * without GitHub rejecting the request. So this is an external-protocol
 * requirement, signed directly with node:crypto's createSign("RSA-SHA256")
 * (== RS256), deliberately outside the internal registry. rs256 IS registered
 * in algorithms.ts as a slot, but the registry's signer is wired for our own
 * HS256 session-token shape; reusing it here would couple an external protocol
 * to our internal token machinery. Keep it isolated and documented.
 *
 * SECURITY: the private key (GITHUB_APP_PRIVATE_KEY, a PEM) is read from env
 * and NEVER logged. The signed JWT is short-lived (<= 10 min, GitHub's max)
 * and also never logged.
 */

import { createSign } from "node:crypto";

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf-8") : input;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export interface AppJwtConfig {
  /** GitHub App id (GITHUB_APP_ID). */
  appId: string;
  /** RSA private key PEM (GITHUB_APP_PRIVATE_KEY). */
  privateKeyPem: string;
}

export interface AppJwtDeps {
  /** Injectable clock (ms since epoch) for deterministic tests. */
  now?: () => number;
}

/**
 * Read the GitHub App config from env. Returns null when EITHER the App id or
 * the private key is missing - this is the signal that the App is "not
 * configured", which the token resolver uses to fall back to the PAT. Never
 * throws and never logs the key.
 */
export function readAppConfigFromEnv(): AppJwtConfig | null {
  const appId = process.env.GITHUB_APP_ID?.trim();
  let privateKeyPem = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKeyPem) return null;
  /* Env vars frequently carry the PEM with literal "\n" instead of real
     newlines (Vercel single-line env). Normalise so createSign accepts it. */
  if (privateKeyPem.includes("\\n")) {
    privateKeyPem = privateKeyPem.replace(/\\n/g, "\n");
  }
  privateKeyPem = privateKeyPem.trim();
  if (!privateKeyPem.includes("BEGIN") || !privateKeyPem.includes("PRIVATE KEY")) {
    return null;
  }
  return { appId, privateKeyPem };
}

/**
 * Sign a short-lived RS256 App JWT. `iat` is backdated 30s to tolerate minor
 * clock drift between us and GitHub (GitHub's own docs recommend this); `exp`
 * is +9 minutes, safely under GitHub's 10-minute ceiling.
 */
export function signAppJwt(config: AppJwtConfig, deps: AppJwtDeps = {}): string {
  const nowMs = (deps.now ?? Date.now)();
  const nowSec = Math.floor(nowMs / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    // Backdate to absorb clock drift.
    iat: nowSec - 30,
    // 9 minutes - under GitHub's 10-minute maximum.
    exp: nowSec + 9 * 60,
    iss: config.appId,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(payload),
  )}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(config.privateKeyPem);
  return `${signingInput}.${base64url(signature)}`;
}
