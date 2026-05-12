/**
 * github-secrets — set Actions secrets on per-client repos.
 *
 * When Instinct provisions a new client site it needs five GitHub Actions
 * secrets on the freshly created repo before its canary-deploy workflow
 * can run. GitHub's "create or update repository secret" endpoint requires
 * the secret value to be sealed with libsodium's sealed_box against the
 * repo's public key; no avoiding NaCl here, hence the ONE new runtime dep
 * libsodium-wrappers.
 *
 * Shape mirrors github-client.ts: every call goes through the injected
 * GithubClient.fetch so tests can stub without network, and the PAT comes
 * from GITHUB_TOKEN_WOLFPACK_AGENCY (already required by defaultGithubClient).
 *
 * Idempotent: PUT /repos/{owner}/{repo}/actions/secrets/{name} overwrites an
 * existing secret of the same name, so re-running provisioning is safe.
 *
 * SECURITY NOTE: server-only. The PAT must never leak into a client bundle.
 * Callers in `src/lib/sites.ts` run inside Next.js server routes.
 *
 * The libsodium-wrappers package has no official .d.ts; we shape the subset
 * we actually use below so `tsc --noEmit` stays green without the deprecated
 * @types/libsodium-wrappers stub.
 */
import type { GithubClient } from "@/lib/github-client";

/**
 * Minimal surface of libsodium-wrappers we depend on. Keeps the typing
 * honest — if libsodium ever renames crypto_box_seal we'll see a compile
 * error instead of a runtime mystery.
 */
export interface SodiumLike {
  /** Resolves when the WASM module is ready. Must be awaited before use. */
  ready: Promise<void>;
  /** Bytes of overhead added by sealed_box on top of the message length. */
  crypto_box_SEALBYTES: number;
  /**
   * sealed_box encrypt. Returns Uint8Array when outputFormat is omitted
   * or "uint8array". We used to request "base64" here, but libsodium's
   * built-in base64 output is URL-safe-without-padding by default, and
   * GitHub's secrets API strictly rejects anything that isn't standard
   * base64 (regex /^[A-Za-z0-9+/]+=*$/) — so we encode manually via
   * `to_base64(bytes, base64_variants.ORIGINAL)`.
   */
  crypto_box_seal(
    message: Uint8Array | string,
    publicKey: Uint8Array,
    outputFormat?: "uint8array" | "base64",
  ): Uint8Array | string;
  /** Base64 → Uint8Array decoder. GitHub returns the public key in base64. */
  from_base64(input: string, variant?: number): Uint8Array;
  /** Uint8Array → Base64 encoder; variant controls URL-safe vs standard. */
  to_base64(bytes: Uint8Array, variant?: number): string;
  /** Base64 variant constant — GitHub uses standard (not URL-safe) base64. */
  base64_variants: { ORIGINAL: number };
}

/**
 * Internal sodium loader. Hoisted so tests can stub it via `__setSodiumForTests`.
 * The dynamic import avoids pulling the ~400KB WASM payload into the cold-start
 * path of server routes that don't set secrets.
 */
let sodiumImpl: SodiumLike | null = null;

async function getSodium(): Promise<SodiumLike> {
  if (sodiumImpl) {
    await sodiumImpl.ready;
    return sodiumImpl;
  }
   
  const mod = require("libsodium-wrappers") as SodiumLike;
  sodiumImpl = mod;
  await sodiumImpl.ready;
  return sodiumImpl;
}

/**
 * TEST-ONLY: inject a fake sodium so `setRepoSecret` can be tested
 * deterministically without touching the real WASM module. Pass `null` to
 * reset to the real import.
 */
export function __setSodiumForTests(fake: SodiumLike | null): void {
  sodiumImpl = fake;
}

export interface RepoPublicKey {
  key_id: string;
  key: string; // base64
}

export class GithubSecretError extends Error {
  public status: number;
  public repo: string;
  public secretName?: string;
  constructor(status: number, repo: string, body: string, secretName?: string) {
    const target = secretName ? `${repo} / ${secretName}` : repo;
    super(`github secrets ${status} on ${target}: ${body.slice(0, 200)}`);
    this.name = "GithubSecretError";
    this.status = status;
    this.repo = repo;
    this.secretName = secretName;
  }
}

/**
 * GET /repos/{owner}/{repo}/actions/secrets/public-key — returns the NaCl
 * key_id + base64 public key used for sealed_box encryption of secrets.
 *
 * 404 → GithubSecretError (repo missing or PAT lacks repo access).
 * 403 → GithubSecretError (PAT lacks `secrets:write`).
 * Any other non-2xx → GithubSecretError with the original status preserved.
 */
async function fetchPublicKey(
  client: GithubClient,
  repoFullName: string,
): Promise<RepoPublicKey> {
  if (!client.token) {
    throw new Error(
      "GITHUB_TOKEN_WOLFPACK_AGENCY not set — refusing to call GitHub secrets API",
    );
  }
  const url = `https://api.github.com/repos/${repoFullName}/actions/secrets/public-key`;
  const res = await client.fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${client.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "wolfpack-instinct-sites",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GithubSecretError(res.status, repoFullName, text);
  }
  const body = (await res.json()) as { key_id?: string; key?: string };
  if (!body.key_id || !body.key) {
    throw new GithubSecretError(
      502,
      repoFullName,
      `public-key response malformed: ${JSON.stringify(body).slice(0, 200)}`,
    );
  }
  return { key_id: body.key_id, key: body.key };
}

/**
 * Seal a secret value with libsodium sealed_box against the given repo
 * public key, then PUT it to /repos/{owner}/{repo}/actions/secrets/{name}.
 *
 * Idempotent: GitHub's endpoint creates or updates in the same call.
 *
 * Returns { ok: true } on 201/204. Throws GithubSecretError on any other
 * status so the caller (provisionClientRepoSecrets) can emit an analytics
 * event per-secret without letting one bad secret fail the entire batch.
 */
export async function setRepoSecret(
  client: GithubClient,
  repoFullName: string,
  name: string,
  value: string,
): Promise<{ ok: true }> {
  if (!client.token) {
    throw new Error(
      "GITHUB_TOKEN_WOLFPACK_AGENCY not set — refusing to call GitHub secrets API",
    );
  }
  const pubKey = await fetchPublicKey(client, repoFullName);
  const sodium = await getSodium();
  const keyBytes = sodium.from_base64(pubKey.key, sodium.base64_variants.ORIGINAL);
  // crypto_box_seal's built-in base64 output is URL-safe-without-padding,
  // which GitHub's secrets API rejects with HTTP 422 "Invalid request"
  // (its regex requires /^[A-Za-z0-9+/]+=*$/). Get the raw bytes and
  // encode manually with the ORIGINAL (standard) variant instead.
  const sealedBytes = sodium.crypto_box_seal(value, keyBytes) as Uint8Array;
  const sealed = sodium.to_base64(sealedBytes, sodium.base64_variants.ORIGINAL);

  const url = `https://api.github.com/repos/${repoFullName}/actions/secrets/${encodeURIComponent(name)}`;
  const res = await client.fetch(url, {
    method: "PUT",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${client.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "wolfpack-instinct-sites",
    },
    body: JSON.stringify({
      encrypted_value: sealed,
      key_id: pubKey.key_id,
    }),
  });
  if (res.status === 201 || res.status === 204) return { ok: true };
  const text = await res.text().catch(() => "");
  throw new GithubSecretError(res.status, repoFullName, text, name);
}
