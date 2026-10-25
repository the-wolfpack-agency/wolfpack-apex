/**
 * secret-storage.ts - AES-256-GCM helper for at-rest encryption of
 * tenant secrets (connector credentials, OAuth tokens, MFA seeds, anything
 * sensitive that has to land in Postgres).
 *
 * KEYRING
 *
 *   primary   INSTINCT_SECRET_KEY (32 bytes, hex or base64). The ONLY key new
 *             values are encrypted with, whenever it is set and valid.
 *   previous  INSTINCT_SECRET_KEY_PREVIOUS (comma-separated, same encoding).
 *             Decrypt only. Lets a primary be rotated without a flag day.
 *   legacy    The original derivation: sha256("secret-storage:v1:" +
 *             (INSTINCT_JWT_SECRET ?? "instinct-dev-only")). Decrypt only once
 *             a primary is set. Kept byte-for-byte so every value written
 *             before the keyring existed stays readable. It is removed in a
 *             later change once scripts/rotate-secret-key.ts reports zero
 *             legacy values (docs/security/at-rest-key-rotation.md).
 *
 *   When no valid primary is configured, encryption falls back to the legacy
 *   key exactly as before, so nothing breaks before the env var is set. In
 *   production that is reported loudly (console.error and the
 *   security.secret_key_degraded event, once per process).
 *
 * FORMAT
 *
 *   v1.<base64-iv>.<base64-tag>.<base64-ciphertext>           (no key id)
 *   v1.k<16 hex>.<base64-iv>.<base64-tag>.<base64-ciphertext> (key id)
 *
 *   The key id is the first 8 bytes of sha256("secret-storage:kid:" + key),
 *   so it names a key without revealing it. Base64 never contains ".", so
 *   the segment count tells the two shapes apart and old tokens parse
 *   unchanged. Values encrypted under the primary carry its key id; values
 *   encrypted in the legacy fallback keep the original shape. Every existing
 *   "v1." prefix check (graph-token-storage, mfa-proof, platform evidence)
 *   holds for both.
 *
 * NEVER throws on encrypt - input gets a well-formed v1 token back.
 * Decrypt returns null on any failure so callers can distinguish
 * "decrypted to empty" from "decryption failed." No error or log line
 * produced here ever carries plaintext, ciphertext or key material.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { trackEvent } from "@/lib/analytics";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const PREFIX = "v1.";
const DERIVATION_LABEL = "secret-storage:v1";
const KID_LABEL = "secret-storage:kid:";
const KID_RE = /^k[0-9a-f]{16}$/;

export type SecretKeyClass = "primary" | "previous" | "legacy";

interface KeyEntry {
  kid: string;
  key: Buffer;
  keyClass: SecretKeyClass;
}

interface Keyring {
  primary: KeyEntry | null;
  previous: KeyEntry[];
  legacy: KeyEntry;
  /** Why there is no primary, when there is none. */
  primaryProblem: "unset" | "invalid" | null;
  invalidPrevious: number;
}

/**
 * Parse 32 bytes of key material from hex (64 chars) or base64. Returns null
 * for anything else, including a `vercel env pull` redaction placeholder.
 */
export function parseSecretKeyMaterial(raw: string | undefined | null): Buffer | null {
  /* Same acceptance rule as the original resolver (no trimming, Node's
     lenient base64), so a key that worked before still yields the same bytes. */
  if (!raw || raw.length < 32) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  if (/SENSITIVE|REDACTED/i.test(raw)) return null;
  try {
    const b = Buffer.from(raw, "base64");
    return b.length === KEY_BYTES ? b : null;
  } catch {
    return null;
  }
}

/** The key id that names a key in a token. Not secret. */
export function secretKeyId(key: Buffer): string {
  return "k" + createHash("sha256").update(KID_LABEL).update(key).digest().subarray(0, 8).toString("hex");
}

/** The original derivation, unchanged. Read-only once a primary is set. */
function legacyKey(env: NodeJS.ProcessEnv): Buffer {
  const jwt = env.INSTINCT_JWT_SECRET ?? "instinct-dev-only";
  return createHash("sha256").update(DERIVATION_LABEL).update(":").update(jwt).digest();
}

function entry(key: Buffer, keyClass: SecretKeyClass): KeyEntry {
  return { kid: secretKeyId(key), key, keyClass };
}

function buildKeyring(env: NodeJS.ProcessEnv): Keyring {
  const raw = env.INSTINCT_SECRET_KEY;
  const primaryKey = parseSecretKeyMaterial(raw);
  const primary = primaryKey ? entry(primaryKey, "primary") : null;
  const previous: KeyEntry[] = [];
  let invalidPrevious = 0;
  for (const part of (env.INSTINCT_SECRET_KEY_PREVIOUS ?? "").split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const k = parseSecretKeyMaterial(trimmed);
    if (!k) {
      invalidPrevious++;
      continue;
    }
    const e = entry(k, "previous");
    if (primary && e.kid === primary.kid) continue;
    if (previous.some((p) => p.kid === e.kid)) continue;
    previous.push(e);
  }
  return {
    primary,
    previous,
    legacy: entry(legacyKey(env), "legacy"),
    primaryProblem: primary ? null : raw ? "invalid" : "unset",
    invalidPrevious,
  };
}

/* ── signals: once per process, never carrying a secret ─────────────────── */

export interface SecretKeySignal {
  event:
    | "security.secret_key_degraded"
    | "security.secret_key_primary_active"
    | "security.secret_old_key_decrypt";
  metadata: Record<string, string | number | boolean>;
}

function isProductionRuntime(env: NodeJS.ProcessEnv): boolean {
  return env.VERCEL_ENV === "production" || env.NODE_ENV === "production";
}

/** Default sink: analytics, skipped under jest so unrelated suites that mock
 *  analytics do not see crypto events. Tests swap the sink to observe. */
function defaultSink(signal: SecretKeySignal): void {
  if (process.env.NODE_ENV === "test") return;
  try {
    trackEvent(signal.event, "system", "system", signal.metadata);
  } catch {
    /* A diagnostic must never break the decrypt it describes. */
  }
}

let _sink: (signal: SecretKeySignal) => void = defaultSink;
const _signalled = new Set<string>();

function signalOnce(key: string, signal: SecretKeySignal): void {
  if (_signalled.has(key)) return;
  _signalled.add(key);
  try {
    _sink(signal);
  } catch {
    /* swallow: see defaultSink */
  }
}

let _cachedKeyring: Keyring | null = null;

function keyring(): Keyring {
  if (_cachedKeyring) return _cachedKeyring;
  const ring = buildKeyring(process.env);
  _cachedKeyring = ring;
  if (ring.primary) {
    signalOnce("primary_active", {
      event: "security.secret_key_primary_active",
      metadata: { primary_kid: ring.primary.kid, previous_count: ring.previous.length, invalid_previous: ring.invalidPrevious },
    });
  } else if (isProductionRuntime(process.env)) {
    console.error(
      `[secret-storage] DEGRADED: INSTINCT_SECRET_KEY is ${ring.primaryProblem}. ` +
        "New secrets are being encrypted with the legacy derived key. " +
        "See docs/security/at-rest-key-rotation.md.",
    );
    signalOnce("degraded", {
      event: "security.secret_key_degraded",
      metadata: { reason: `primary_${ring.primaryProblem}`, legacy_kid: ring.legacy.kid },
    });
  }
  return ring;
}

/** Non-secret description of the active keyring (for the rotation script). */
export interface KeyringStatus {
  primaryKid: string | null;
  primaryProblem: "unset" | "invalid" | null;
  previousKids: string[];
  invalidPrevious: number;
  legacyKid: string;
}

export function secretKeyringStatus(): KeyringStatus {
  const r = keyring();
  return {
    primaryKid: r.primary?.kid ?? null,
    primaryProblem: r.primaryProblem,
    previousKids: r.previous.map((p) => p.kid),
    invalidPrevious: r.invalidPrevious,
    legacyKid: r.legacy.kid,
  };
}

/* ── encrypt ────────────────────────────────────────────────────────────── */

function sealWith(plaintext: string, k: KeyEntry, withKid: boolean): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, k.key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const body = `${iv.toString("base64")}.${tag.toString("base64")}.${ct.toString("base64")}`;
  return withKid ? `${PREFIX}${k.kid}.${body}` : `${PREFIX}${body}`;
}

/**
 * Encrypt a plaintext string. Returns the v1 token. Uses the primary key when
 * one is configured, else the legacy key (today's behavior, reported as
 * degraded in production). On unexpected error, returns the plaintext
 * prefixed with "plain." so a careful deploy can detect mis-encryption
 * without losing the data, but normal runs always return a v1 token.
 */
export function encryptSecret(plaintext: string): string {
  if (typeof plaintext !== "string") plaintext = String(plaintext);
  try {
    const r = keyring();
    return r.primary ? sealWith(plaintext, r.primary, true) : sealWith(plaintext, r.legacy, false);
  } catch {
    return `plain.${Buffer.from(plaintext, "utf8").toString("base64")}`;
  }
}

/** Thrown by encryptSecretWithPrimary. Never carries the value. */
export class PrimaryKeyUnavailableError extends Error {
  constructor() {
    super("INSTINCT_SECRET_KEY is not configured; refusing to encrypt with a non-primary key");
    this.name = "PrimaryKeyUnavailableError";
  }
}

/** Encrypt with the primary key or THROW. For the rotation backfill, which
 *  must never write a value under the legacy key. */
export function encryptSecretWithPrimary(plaintext: string): string {
  const r = keyring();
  if (!r.primary) throw new PrimaryKeyUnavailableError();
  return sealWith(plaintext, r.primary, true);
}

/* ── decrypt ────────────────────────────────────────────────────────────── */

export type DecryptedSecret =
  | { ok: true; value: string; format: "v1"; keyClass: SecretKeyClass; kid: string }
  | { ok: true; value: string; format: "plain_envelope" | "raw_plaintext" }
  | { ok: false };

function tryOpen(k: KeyEntry, iv: Buffer, tag: Buffer, ct: Buffer): string | null {
  try {
    const decipher = createDecipheriv(ALGO, k.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Decrypt and say which key opened it. Never throws. */
export function decryptSecretWithInfo(token: string): DecryptedSecret {
  if (!token || typeof token !== "string") return { ok: false };
  if (token.startsWith(PREFIX)) {
    const parts = token.slice(PREFIX.length).split(".");
    let kid: string | null = null;
    if (parts.length === 4) {
      if (!KID_RE.test(parts[0])) return { ok: false };
      kid = parts.shift() as string;
    }
    if (parts.length !== 3) return { ok: false };
    let iv: Buffer, tag: Buffer, ct: Buffer;
    try {
      iv = Buffer.from(parts[0], "base64");
      tag = Buffer.from(parts[1], "base64");
      ct = Buffer.from(parts[2], "base64");
    } catch {
      return { ok: false };
    }
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return { ok: false };
    let r: Keyring;
    try {
      r = keyring();
    } catch {
      return { ok: false };
    }
    const all: KeyEntry[] = [...(r.primary ? [r.primary] : []), ...r.previous, r.legacy];
    /* A token that names its key is tried with that key first; GCM's tag is
       the real check, so a stale or forged id costs one extra attempt, never
       a wrong answer. */
    const order = kid ? [...all.filter((k) => k.kid === kid), ...all.filter((k) => k.kid !== kid)] : all;
    for (const k of order) {
      const value = tryOpen(k, iv, tag, ct);
      if (value === null) continue;
      if (k.keyClass !== "primary" && r.primary) {
        signalOnce(`old_key:${k.keyClass}:${k.kid}`, {
          event: "security.secret_old_key_decrypt",
          metadata: { key_class: k.keyClass, kid: k.kid, primary_kid: r.primary.kid },
        });
      }
      return { ok: true, value, format: "v1", keyClass: k.keyClass, kid: k.kid };
    }
    return { ok: false };
  }
  if (token.startsWith("plain.")) {
    try {
      return { ok: true, value: Buffer.from(token.slice(6), "base64").toString("utf8"), format: "plain_envelope" };
    } catch {
      return { ok: false };
    }
  }
  /* Pre-v1: row stored as raw plaintext. Surface verbatim during the
     migration window; the credential loader will re-encrypt on the
     next write. */
  return { ok: true, value: token, format: "raw_plaintext" };
}

/**
 * Decrypt a v1 token. Returns the plaintext string when the token is
 * valid AND the tag verifies under any key in the keyring. Returns null on
 * ANY failure: bad format, wrong key, tampered ciphertext. Callers should
 * treat null as "credential unavailable" not "credential is empty."
 *
 * For backwards compat: tokens prefixed "plain." (the encrypt fallback)
 * decode to base64-decoded plaintext. Pre-v1 plain rows (no prefix)
 * are returned verbatim, useful during the migration window when
 * existing rows might not yet be encrypted.
 */
export function decryptSecret(token: string): string | null {
  const r = decryptSecretWithInfo(token);
  return r.ok ? r.value : null;
}

/** Test seam: clear the in-process keyring and the once-per-process signals. */
export function __resetSecretKeyCacheForTests(): void {
  _cachedKeyring = null;
  _signalled.clear();
}

/** Replace where signals go. Tests observe through it; the rotation script
 *  silences it so the operator's shell never reports itself as the app. Pass
 *  null to restore the analytics sink. */
export function setSecretKeySignalSink(sink: ((s: SecretKeySignal) => void) | null): void {
  _sink = sink ?? defaultSink;
}
