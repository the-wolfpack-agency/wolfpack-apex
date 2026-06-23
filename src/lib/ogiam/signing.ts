/**
 * OGIAM checkpoint signing: notarize the decision chain so it is not just
 * tamper-evident but non-repudiable.
 *
 * The Phase 0 ledger is a per-workspace hash chain: tamper-evident, but an
 * attacker who can write the database could rewrite the whole chain
 * consistently. Signing fixes that: a signature over the chain head, produced
 * by a key the application cannot exfiltrate, cannot be reproduced by a DB
 * rewrite. The attacker would have to also forge a signature from a key they do
 * not hold.
 *
 * Design decisions (compared, not defaulted):
 *
 *   What to sign:
 *     - Per-decision signature: strongest granularity but a Key Vault round trip
 *       on every tool call, in the hot path. Rejected on latency.
 *     - Checkpoint (signed chain head): one signature anchors every decision up
 *       to that point, like a Certificate Transparency signed tree head. A
 *       handful of signatures per day instead of one per action. CHOSEN.
 *
 *   Key custody:
 *     - Local asymmetric / HMAC key in app env: fast, but a compromised app can
 *       forge. Kept ONLY as a clearly-marked dev fallback.
 *     - Azure Key Vault asymmetric key (ES256): the private key never leaves the
 *       vault; the app calls a sign operation. Real non-repudiation. CHOSEN for
 *       production. Reached over REST with a client-credentials token rather
 *       than the @azure SDK, so no new runtime dependency is added (the infra
 *       rule), and it works from Vercel, which has no managed identity.
 *
 * Graceful degradation: when Key Vault is not configured, the signer is the
 * local HMAC fallback in development, or disabled in production with no local
 * secret. A disabled signer never throws; the chain stays tamper-evident and the
 * explorer shows that notarization is not yet configured.
 */

import {
  createHash,
  createHmac,
  createPublicKey,
  verify as cryptoVerify,
  type JsonWebKey as CryptoJsonWebKey,
} from "crypto";

export interface SignResult {
  /** base64 signature, or null when signing is disabled or failed. */
  signature: string | null;
  /** Identifier of the key that signed (vault key id, or a local label). */
  keyId: string;
  /** Algorithm label recorded with the checkpoint so verification can dispatch. */
  algorithm: string;
}

export interface OgiamSigner {
  readonly keyId: string;
  readonly algorithm: string;
  /** Whether this signer produces real (non-local) signatures. */
  readonly isProduction: boolean;
  /** A short label of the active mode for diagnostics: keyvault, local, none. */
  readonly mode: "keyvault" | "local" | "none";
  /** Sign the canonical payload. Best effort: returns a null signature on
   *  failure rather than throwing. */
  sign(payload: string): Promise<SignResult>;
  /** Independently verify a signature over a payload. Returns false (never
   *  throws) on any error or when verification is not possible. This is the
   *  offline verifiability the non-repudiation story depends on: a stored
   *  checkpoint signature can be re-checked later against the public key. */
  verify(payload: string, signature: string): Promise<boolean>;
}

/** The canonical bytes a checkpoint commits to. Kept stable so verification
 *  reproduces the exact input. */
export function checkpointPayload(
  workspaceId: string,
  throughSeq: number,
  headHash: string,
): string {
  return JSON.stringify({ w: workspaceId, s: throughSeq, h: headHash });
}

function sha256Bytes(input: string): Buffer {
  return createHash("sha256").update(input).digest();
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToBuffer(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** EC P-256 public key in JWK form, as Key Vault returns it. */
export interface EcPublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

/**
 * Verify an ES256 signature (raw r||s, as Azure Key Vault returns it) over the
 * payload, using the EC public key. Independent of Key Vault: a third party can
 * run the same check offline. Returns false on any error rather than throwing.
 */
export function verifyEs256(
  payload: string,
  signatureB64url: string,
  jwk: EcPublicJwk,
): boolean {
  try {
    const key = createPublicKey({ key: jwk as unknown as CryptoJsonWebKey, format: "jwk" });
    const sig = base64urlToBuffer(signatureB64url);
    return cryptoVerify(
      "sha256",
      Buffer.from(payload),
      { key, dsaEncoding: "ieee-p1363" },
      sig,
    );
  } catch {
    return false;
  }
}

/** Signing disabled: chain stays tamper-evident, no notarization. */
class NullSigner implements OgiamSigner {
  readonly keyId = "none";
  readonly algorithm = "none";
  readonly isProduction = false;
  readonly mode = "none" as const;
  async sign(): Promise<SignResult> {
    return { signature: null, keyId: this.keyId, algorithm: this.algorithm };
  }
  async verify(): Promise<boolean> {
    return false;
  }
}

/** Dev fallback: HMAC over the payload with a local secret. Symmetric, app
 *  held, so NOT real non-repudiation. Used only when Key Vault is not
 *  configured and a local secret exists (local dev). */
class LocalHmacSigner implements OgiamSigner {
  readonly keyId = "local-hmac";
  readonly algorithm = "HS256-local";
  readonly isProduction = false;
  readonly mode = "local" as const;
  constructor(private readonly secret: string) {}
  async sign(payload: string): Promise<SignResult> {
    const sig = createHmac("sha256", this.secret).update(payload).digest("base64");
    return { signature: sig, keyId: this.keyId, algorithm: this.algorithm };
  }
  async verify(payload: string, signature: string): Promise<boolean> {
    return verifyLocalHmac(payload, signature, this.secret);
  }
}

interface KeyVaultConfig {
  vaultUrl: string;
  keyName: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

/** Cached AAD token so we do not fetch one per checkpoint. */
let cachedToken: { token: string; expiresAtMs: number } | null = null;

/** Production: sign the payload's SHA-256 digest with an Azure Key Vault
 *  asymmetric key (ES256) over REST. The private key never leaves the vault. */
export class KeyVaultSigner implements OgiamSigner {
  readonly algorithm = "ES256";
  readonly isProduction = true;
  readonly mode = "keyvault" as const;
  constructor(private readonly cfg: KeyVaultConfig) {}
  get keyId(): string {
    return `${this.cfg.vaultUrl.replace(/\/$/, "")}/keys/${this.cfg.keyName}`;
  }

  private async getToken(nowMs: number): Promise<string | null> {
    if (cachedToken && cachedToken.expiresAtMs > nowMs + 60_000) {
      return cachedToken.token;
    }
    const body = new URLSearchParams({
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      grant_type: "client_credentials",
      scope: "https://vault.azure.net/.default",
    });
    const res = await fetch(
      `https://login.microsoftonline.com/${this.cfg.tenantId}/oauth2/v2.0/token`,
      { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) return null;
    cachedToken = {
      token: json.access_token,
      expiresAtMs: nowMs + (json.expires_in ?? 3600) * 1000,
    };
    return json.access_token;
  }

  async sign(payload: string): Promise<SignResult> {
    try {
      const token = await this.getToken(Date.now());
      if (!token) return { signature: null, keyId: this.keyId, algorithm: this.algorithm };
      const digest = base64url(sha256Bytes(payload));
      const res = await fetch(
        `${this.cfg.vaultUrl.replace(/\/$/, "")}/keys/${this.cfg.keyName}/sign?api-version=7.4`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ alg: this.algorithm, value: digest }),
        },
      );
      if (!res.ok) return { signature: null, keyId: this.keyId, algorithm: this.algorithm };
      const json = (await res.json()) as { kid?: string; value?: string };
      if (!json.value) return { signature: null, keyId: this.keyId, algorithm: this.algorithm };
      return {
        signature: json.value,
        keyId: json.kid ?? this.keyId,
        algorithm: this.algorithm,
      };
    } catch {
      return { signature: null, keyId: this.keyId, algorithm: this.algorithm };
    }
  }

  /** Fetch the EC public key (public material only) so signatures can be
   *  verified independently. Returns null on any failure. */
  private async getPublicJwk(): Promise<EcPublicJwk | null> {
    try {
      const token = await this.getToken(Date.now());
      if (!token) return null;
      const res = await fetch(
        `${this.cfg.vaultUrl.replace(/\/$/, "")}/keys/${this.cfg.keyName}?api-version=7.4`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) return null;
      const json = (await res.json()) as { key?: { kty?: string; crv?: string; x?: string; y?: string } };
      const k = json.key;
      if (!k || k.kty !== "EC" || k.crv !== "P-256" || !k.x || !k.y) return null;
      return { kty: "EC", crv: "P-256", x: k.x, y: k.y };
    } catch {
      return null;
    }
  }

  async verify(payload: string, signature: string): Promise<boolean> {
    const jwk = await this.getPublicJwk();
    if (!jwk) return false;
    return verifyEs256(payload, signature, jwk);
  }
}

/** Read Key Vault config from the environment, or null when not fully set. */
export function readKeyVaultConfig(
  env: NodeJS.ProcessEnv = process.env,
): KeyVaultConfig | null {
  const vaultUrl = env.OGIAM_KEYVAULT_URL;
  const keyName = env.OGIAM_KEYVAULT_KEY;
  const tenantId = env.AZURE_TENANT_ID;
  const clientId = env.AZURE_CLIENT_ID;
  const clientSecret = env.AZURE_CLIENT_SECRET;
  if (vaultUrl && keyName && tenantId && clientId && clientSecret) {
    return { vaultUrl, keyName, tenantId, clientId, clientSecret };
  }
  return null;
}

/**
 * Resolve the active signer:
 *   1. Azure Key Vault when fully configured (production non-repudiation).
 *   2. Local HMAC when a local OGIAM_SIGNING_SECRET exists and we are not in
 *      production (dev convenience, clearly marked non-production).
 *   3. Disabled otherwise.
 */
export function getSigner(env: NodeJS.ProcessEnv = process.env): OgiamSigner {
  const kv = readKeyVaultConfig(env);
  if (kv) return new KeyVaultSigner(kv);
  const localSecret = env.OGIAM_SIGNING_SECRET;
  if (localSecret && env.NODE_ENV !== "production") {
    return new LocalHmacSigner(localSecret);
  }
  return new NullSigner();
}

export interface SignerSelfTestResult {
  /** keyvault, local, or none. */
  mode: OgiamSigner["mode"];
  /** True for the Key Vault path (real non-repudiation). */
  isProduction: boolean;
  /** True when a signature was produced. */
  signed: boolean;
  /** True when the produced signature verified independently (sign then verify
   *  round trip). The strongest "the wiring works" proof. */
  verified: boolean;
  /** Public key identifier (not a secret). Empty when disabled. */
  keyId: string;
  algorithm: string;
  latencyMs: number;
}

/**
 * Probe the configured signer end to end: sign a SERVER-GENERATED probe (never a
 * caller-supplied value, so the endpoint cannot be used as a signing oracle),
 * then independently verify the signature. Pure of secrets: returns only status
 * and the public key id. Never throws.
 */
export async function runSignerSelfTest(
  signer: OgiamSigner,
  nonce: string,
): Promise<SignerSelfTestResult> {
  const probe = `ogiam:keyvault-selftest:${nonce}`;
  const started = Date.now();
  let signed = false;
  let verified = false;
  let keyId = signer.keyId;
  try {
    const sig = await signer.sign(probe);
    keyId = sig.keyId;
    signed = sig.signature != null;
    if (signed && sig.signature) {
      verified = await signer.verify(probe, sig.signature);
    }
  } catch {
    /* never throw; report what we have */
  }
  return {
    mode: signer.mode,
    isProduction: signer.isProduction,
    signed,
    verified,
    keyId: signer.mode === "none" ? "" : keyId,
    algorithm: signer.algorithm,
    latencyMs: Date.now() - started,
  };
}

/** Verify a local HMAC signature (used by the dev fallback path). Key Vault
 *  signatures are verified asymmetrically against the vault public key, which is
 *  a separate concern from this symmetric check. */
export function verifyLocalHmac(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  const expected = createHmac("sha256", secret).update(payload).digest("base64");
  // Constant-time compare on equal-length strings.
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
