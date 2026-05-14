/**
 * secret-storage.ts — AES-256-GCM helper for at-rest encryption of
 * tenant secrets (connector credentials, OAuth tokens, anything
 * sensitive that has to land in Postgres).
 *
 * Key source priority:
 *   1. INSTINCT_SECRET_KEY env var (32-byte hex or base64).
 *   2. Derived from INSTINCT_JWT_SECRET via HKDF-style hash — keeps
 *      single-secret deployments working without an extra env var.
 *      The derivation is namespaced ("secret-storage:v1") so the
 *      key cannot be confused with the JWT signing key.
 *
 * Format on the wire:
 *   v1.<base64-iv>.<base64-tag>.<base64-ciphertext>
 *
 * Why v1.* prefix: lets us rotate algorithms without a destructive
 * migration. A future v2 (e.g. ML-DSA wrapper, KMS-backed) tags every
 * row so we can decrypt-old / encrypt-new during a rolling rotation.
 *
 * NEVER throws on encrypt — input gets a well-formed v1 token back.
 * Decrypt returns null on any failure so callers can distinguish
 * "decrypted to empty" from "decryption failed."
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const PREFIX = "v1.";
const DERIVATION_LABEL = "secret-storage:v1";

let _cachedKey: Buffer | null = null;

function resolveKey(): Buffer {
  if (_cachedKey) return _cachedKey;
  const raw = process.env.INSTINCT_SECRET_KEY;
  if (raw && raw.length >= 32) {
    /* Accept hex (64 chars) or base64 (44 chars including padding). */
    const fromHex = /^[0-9a-fA-F]{64}$/.test(raw)
      ? Buffer.from(raw, "hex")
      : null;
    const fromB64 = !fromHex
      ? safeBase64Decode(raw, KEY_BYTES)
      : null;
    const key = fromHex ?? fromB64;
    if (key && key.length === KEY_BYTES) {
      _cachedKey = key;
      return key;
    }
  }
  /* Fallback: derive a stable 32-byte key from JWT secret + label. */
  const jwt = process.env.INSTINCT_JWT_SECRET ?? "instinct-dev-only";
  const derived = createHash("sha256")
    .update(DERIVATION_LABEL)
    .update(":")
    .update(jwt)
    .digest();
  _cachedKey = derived;
  return derived;
}

function safeBase64Decode(s: string, expectLen: number): Buffer | null {
  try {
    const b = Buffer.from(s, "base64");
    return b.length === expectLen ? b : null;
  } catch {
    return null;
  }
}

/**
 * Encrypt a plaintext string. Returns the v1 token. On unexpected
 * error, returns the plaintext prefixed with "plain." so a careful
 * deploy can detect mis-encryption without losing the data — but
 * normal runs always return a v1 token.
 */
export function encryptSecret(plaintext: string): string {
  if (typeof plaintext !== "string") plaintext = String(plaintext);
  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, resolveKey(), iv);
    const ct = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString("base64")}.${tag.toString("base64")}.${ct.toString("base64")}`;
  } catch {
    return `plain.${Buffer.from(plaintext, "utf8").toString("base64")}`;
  }
}

/**
 * Decrypt a v1 token. Returns the plaintext string when the token is
 * valid AND the tag verifies. Returns null on ANY failure — bad
 * format, wrong key, tampered ciphertext. Callers should treat null
 * as "credential unavailable" not "credential is empty."
 *
 * For backwards compat: tokens prefixed "plain." (the encrypt fallback)
 * decode to base64-decoded plaintext. Pre-v1 plain rows (no prefix)
 * are returned verbatim — useful during the migration window when
 * existing rows might not yet be encrypted.
 */
export function decryptSecret(token: string): string | null {
  if (!token || typeof token !== "string") return null;
  if (token.startsWith(PREFIX)) {
    const parts = token.slice(PREFIX.length).split(".");
    if (parts.length !== 3) return null;
    try {
      const [ivB64, tagB64, ctB64] = parts;
      const iv = Buffer.from(ivB64, "base64");
      const tag = Buffer.from(tagB64, "base64");
      const ct = Buffer.from(ctB64, "base64");
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
      const decipher = createDecipheriv(ALGO, resolveKey(), iv);
      decipher.setAuthTag(tag);
      const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
      return pt.toString("utf8");
    } catch {
      return null;
    }
  }
  if (token.startsWith("plain.")) {
    try {
      return Buffer.from(token.slice(6), "base64").toString("utf8");
    } catch {
      return null;
    }
  }
  /* Pre-v1: row stored as raw plaintext. Surface verbatim during the
     migration window; the credential loader will re-encrypt on the
     next write. */
  return token;
}

/** Test seam — clear the in-process key cache. */
export function __resetSecretKeyCacheForTests(): void {
  _cachedKey = null;
}
