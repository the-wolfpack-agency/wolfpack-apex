/**
 * graph-token-storage.ts - at-rest sealing for Microsoft Graph OAuth tokens.
 *
 * WHY THIS EXISTS
 *
 * Connector credentials have always been encrypted with secret-storage.ts
 * (AES-256-GCM, v1.<iv>.<tag>.<ct>). The Microsoft Graph access and refresh
 * tokens in instinct_ms_tokens were not: storeTokens wrote them raw, so a
 * database read alone yielded a working Mail.Send / Files / Calendar grant for
 * every connected user. docs/security-posture.md said otherwise.
 *
 * This module REUSES secret-storage.ts (same key, same env var, same format)
 * rather than inventing a second scheme. It adds only the two things the token
 * path needs that the generic helper does not give it:
 *
 *   1. A sealer that REFUSES to return plaintext. encryptSecret falls back to a
 *      base64 "plain." envelope on an unexpected cipher error so connector
 *      writes never lose data. For an OAuth token that fallback would write the
 *      secret readably, which is the bug being fixed, so sealGraphToken throws
 *      instead and the caller reports a failed store.
 *
 *   2. A reader that says WHICH format it found. Rows written before this
 *      change are raw plaintext and must keep working on deploy day, and the
 *      caller needs to know a row is legacy so it can re-seal it (the lazy
 *      backfill). A v1 envelope that fails to authenticate is reported as
 *      tampered, never silently treated as plaintext.
 *
 * Format detection is by prefix. A Microsoft access token is a JWT ("eyJ...")
 * and a refresh token is an opaque string ("0.A..." / "M.C5..."); neither can
 * begin with "v1." or "plain.", so the prefix is unambiguous.
 */

import { decryptSecret, encryptSecret } from "@/lib/crypto/secret-storage";

/** Prefix of the secret-storage v1 envelope (AES-256-GCM). */
export const SEALED_PREFIX = "v1.";
/** Prefix of secret-storage's degraded fallback envelope (base64, NOT encrypted). */
const PLAIN_ENVELOPE_PREFIX = "plain.";

export type StoredTokenFormat = "sealed" | "legacy_plaintext" | "empty";

export type OpenedToken =
  | { ok: true; value: string; format: Exclude<StoredTokenFormat, "empty"> }
  | { ok: true; value: null; format: "empty" }
  | { ok: false; reason: "tampered_or_wrong_key" };

/** Thrown when a token cannot be sealed. Never carries the token. */
export class GraphTokenSealError extends Error {
  constructor() {
    super("graph token could not be sealed; refusing to store it in plaintext");
    this.name = "GraphTokenSealError";
  }
}

/** True when the stored value is a sealed (encrypted) envelope. */
export function isSealedToken(stored: string | null | undefined): boolean {
  return typeof stored === "string" && stored.startsWith(SEALED_PREFIX);
}

/**
 * Seal a token for storage. Returns a v1 envelope or THROWS. Never returns
 * plaintext and never returns the "plain." fallback envelope.
 */
export function sealGraphToken(plaintext: string): string {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new GraphTokenSealError();
  }
  const sealed = encryptSecret(plaintext);
  if (!sealed.startsWith(SEALED_PREFIX)) throw new GraphTokenSealError();
  return sealed;
}

/**
 * Open a stored token.
 *   - v1 envelope that authenticates     -> { ok, value, format: "sealed" }
 *   - v1 envelope that does NOT          -> { ok: false } (tampered or wrong key)
 *   - legacy raw plaintext / "plain."    -> { ok, value, format: "legacy_plaintext" }
 *   - null / empty                       -> { ok, value: null, format: "empty" }
 */
export function openGraphToken(stored: string | null | undefined): OpenedToken {
  if (stored === null || stored === undefined || stored === "") {
    return { ok: true, value: null, format: "empty" };
  }
  if (stored.startsWith(SEALED_PREFIX)) {
    const value = decryptSecret(stored);
    if (value === null) return { ok: false, reason: "tampered_or_wrong_key" };
    return { ok: true, value, format: "sealed" };
  }
  if (stored.startsWith(PLAIN_ENVELOPE_PREFIX)) {
    const value = decryptSecret(stored);
    if (value === null) return { ok: false, reason: "tampered_or_wrong_key" };
    return { ok: true, value, format: "legacy_plaintext" };
  }
  return { ok: true, value: stored, format: "legacy_plaintext" };
}
