/**
 * api-keys.ts - EXTERNAL gate API keys ("bring your own agent").
 *
 * A client mints a scoped key so THEIR external agent can call our OGIAM gate
 * directly. The key authenticates an OgiamPrincipal (kind "ai_agent"): it is
 * scoped to a workspace + an `agent` label and carries an allowlist of
 * capabilities the agent may exercise.
 *
 * Security model (enterprise-grade):
 *   - HASHED AT REST. Only sha256(plaintext) is stored (`key_hash`). The
 *     plaintext is generated from node:crypto randomBytes(32), returned ONCE at
 *     mint time, and never persisted or logged.
 *   - LOOKUP BY PREFIX. `key_prefix` ("ogk_" + first 6 chars of the random body)
 *     finds candidate rows cheaply; the FULL hash is then compared in
 *     CONSTANT TIME (timingSafeEqual) so a wrong key reveals nothing through
 *     timing. `last4` is display-only.
 *   - REVOCABLE. `revoked_at` is set on revoke; verify rejects revoked keys.
 *   - NEVER THROWS from verifyApiKey. The gate depends on a typed result.
 *
 * The verifyApiKey return contract is load-bearing for the gate endpoint:
 *   Promise<
 *     | { ok: true; id; workspaceId; agent; capabilities }
 *     | { ok: false; reason: "not_found" | "revoked" | "malformed" }
 *   >
 *
 * Reads/writes are workspace-scoped on the parameterized `workspace_id` (the
 * app-side isolation predicate, matching the rest of the codebase). All DB
 * access goes through `query` so a missing DATABASE_URL surfaces predictably to
 * the caller; verifyApiKey additionally swallows any DB error into a typed
 * `not_found` so the gate never sees an exception.
 */

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { query } from "@/lib/db";

/** Human-facing key prefix. Lets a leaked string be grep'd + recognised. */
const KEY_NAMESPACE = "ogk_";
/** Bytes of entropy in the key body. 32 bytes = 256 bits. */
const KEY_BYTES = 32;
/** Chars of the random body folded into the lookup prefix (after KEY_NAMESPACE). */
const PREFIX_BODY_CHARS = 6;

export interface CreateApiKeyInput {
  workspaceId: string;
  /** Free-form label for the external agent, e.g. "acme.qa-bot". */
  agent: string;
  /** Allowlist of capabilities this key may exercise at the gate. */
  capabilities: string[];
  /** The operator (user id) minting the key. */
  createdBy: string;
}

export interface CreateApiKeyResult {
  id: string;
  /** Plaintext key. Returned ONCE. Never stored, never logged. */
  plaintextKey: string;
  /** Lookup prefix ("ogk_" + first 6 chars). Safe to display/store. */
  prefix: string;
  /** Last 4 chars of the plaintext, display-only. */
  last4: string;
}

/** EXACT contract the gate endpoint depends on. Do not change shapes. */
export type VerifyApiKeyResult =
  | {
      ok: true;
      id: string;
      workspaceId: string;
      agent: string;
      capabilities: string[];
    }
  | { ok: false; reason: "not_found" | "revoked" | "malformed" };

/** Masked row for the admin list. NEVER includes key_hash or plaintext. */
export interface MaskedApiKey {
  id: string;
  workspaceId: string;
  agent: string;
  prefix: string;
  last4: string | null;
  capabilities: string[];
  createdBy: string | null;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  revoked: boolean;
}

/** sha256 hex of the plaintext key. */
function hashKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

/** Constant-time compare of two hex hash strings. Length-safe (timingSafeEqual
 *  throws on length mismatch, so guard first - a length difference is itself a
 *  mismatch and returning false early leaks no per-byte timing). */
function constantTimeHexEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Generate an opaque, app-side id for a key row. */
function newKeyId(): string {
  return `gak_${randomBytes(12).toString("hex")}`;
}

/** Derive the lookup prefix from a plaintext key. The plaintext is
 *  `${KEY_NAMESPACE}${body}`; the prefix is the namespace plus the first
 *  PREFIX_BODY_CHARS of the body. */
function prefixOf(plaintext: string): string {
  const body = plaintext.slice(KEY_NAMESPACE.length);
  return `${KEY_NAMESPACE}${body.slice(0, PREFIX_BODY_CHARS)}`;
}

/**
 * Mint a new scoped API key. Generates `ogk_<base64url(32 bytes)>`, stores ONLY
 * the sha256 hash + prefix + last4, and returns the plaintext ONCE.
 *
 * The capabilities are normalised (trimmed, de-duped, non-empty) so a malformed
 * allowlist can't slip a blank capability past the gate.
 */
export async function createApiKey(
  input: CreateApiKeyInput,
): Promise<CreateApiKeyResult> {
  const body = randomBytes(KEY_BYTES).toString("base64url");
  const plaintextKey = `${KEY_NAMESPACE}${body}`;
  const id = newKeyId();
  const prefix = prefixOf(plaintextKey);
  const last4 = plaintextKey.slice(-4);
  const keyHash = hashKey(plaintextKey);

  const capabilities = normaliseCapabilities(input.capabilities);

  await query(
    `INSERT INTO instinct_gate_api_keys
       (id, workspace_id, agent, key_hash, key_prefix, last4, capabilities, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      input.workspaceId,
      input.agent,
      keyHash,
      prefix,
      last4,
      capabilities,
      input.createdBy,
    ],
  );

  /* plaintextKey is returned to the caller for one-time display. It is NEVER
     logged here or anywhere downstream. */
  return { id, plaintextKey, prefix, last4 };
}

/** Trim, drop blanks, de-dupe an allowlist of capability strings. */
function normaliseCapabilities(caps: unknown): string[] {
  if (!Array.isArray(caps)) return [];
  const seen = new Set<string>();
  for (const c of caps) {
    if (typeof c !== "string") continue;
    const t = c.trim();
    if (t) seen.add(t);
  }
  return [...seen];
}

interface VerifyRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  agent: string;
  key_hash: string;
  capabilities: string[];
  revoked_at: string | null;
}

/**
 * Verify a raw key presented by an external agent. NEVER throws.
 *
 * 1. Shape check → "malformed" if it isn't a well-formed `ogk_…` key.
 * 2. Look up candidate rows by prefix (cheap, indexed).
 * 3. Constant-time compare the FULL sha256 hash against each candidate.
 * 4. Reject revoked keys → "revoked".
 * 5. Best-effort `last_used_at` update (failure is swallowed).
 *
 * Returns the EXACT contract the gate endpoint consumes.
 */
export async function verifyApiKey(
  rawKey: unknown,
): Promise<VerifyApiKeyResult> {
  if (typeof rawKey !== "string") return { ok: false, reason: "malformed" };
  const key = rawKey.trim();
  // Must be the namespace + a non-trivial body. Reject anything that can't be a
  // real key BEFORE touching the DB.
  if (
    !key.startsWith(KEY_NAMESPACE) ||
    key.length <= KEY_NAMESPACE.length + PREFIX_BODY_CHARS
  ) {
    return { ok: false, reason: "malformed" };
  }

  const prefix = prefixOf(key);
  const presentedHash = hashKey(key);

  let rows: VerifyRow[];
  try {
    const res = await query<VerifyRow>(
      `SELECT id, workspace_id, agent, key_hash, capabilities, revoked_at
         FROM instinct_gate_api_keys
        WHERE key_prefix = $1`,
      [prefix],
    );
    rows = res.rows;
  } catch {
    /* DB unavailable / error: the gate must not crash. Treat as not_found so a
       transient outage fails closed (no key is honoured) without throwing. */
    return { ok: false, reason: "not_found" };
  }

  /* Find the row whose stored hash matches in CONSTANT TIME. We always compare
     against every candidate (no early break on the first row) so the presence
     of a matching prefix can't be inferred from timing. Prefix collisions are
     possible (~6 chars), so there can be more than one candidate. */
  let matched: VerifyRow | null = null;
  for (const row of rows) {
    if (constantTimeHexEqual(presentedHash, row.key_hash)) {
      matched = row;
    }
  }

  if (!matched) return { ok: false, reason: "not_found" };
  if (matched.revoked_at) return { ok: false, reason: "revoked" };

  /* Best-effort usage stamp. Never block or throw on this. */
  void query(
    `UPDATE instinct_gate_api_keys SET last_used_at = NOW() WHERE id = $1`,
    [matched.id],
  ).catch(() => {
    /* swallow: last_used_at is observability, not correctness. */
  });

  return {
    ok: true,
    id: matched.id,
    workspaceId: matched.workspace_id,
    agent: matched.agent,
    capabilities: Array.isArray(matched.capabilities)
      ? matched.capabilities
      : [],
  };
}

/**
 * Revoke a key. Workspace-scoped so a privileged user in workspace A can't
 * revoke a key in workspace B. Idempotent: revoking an already-revoked key
 * leaves the original revoked_at untouched. Returns true when a live key was
 * revoked by this call.
 */
export async function revokeApiKey(
  id: string,
  workspaceId: string,
): Promise<boolean> {
  const res = await query(
    `UPDATE instinct_gate_api_keys
        SET revoked_at = NOW()
      WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL`,
    [id, workspaceId],
  );
  return (res.rowCount ?? 0) > 0;
}

interface ListRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  agent: string;
  key_prefix: string;
  last4: string | null;
  capabilities: string[];
  created_by: string | null;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

/**
 * List a workspace's keys as MASKED rows. Never selects or returns key_hash or
 * any plaintext - only the prefix + last4 for display. Newest first.
 */
export async function listApiKeys(
  workspaceId: string,
): Promise<MaskedApiKey[]> {
  const res = await query<ListRow>(
    `SELECT id, workspace_id, agent, key_prefix, last4, capabilities,
            created_by, created_at, revoked_at, last_used_at
       FROM instinct_gate_api_keys
      WHERE workspace_id = $1
      ORDER BY created_at DESC`,
    [workspaceId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    agent: r.agent,
    prefix: r.key_prefix,
    last4: r.last4,
    capabilities: Array.isArray(r.capabilities) ? r.capabilities : [],
    createdBy: r.created_by,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
    lastUsedAt: r.last_used_at,
    revoked: r.revoked_at !== null,
  }));
}


/**
 * Load an external agent as a delegation target, including its signing secret.
 *
 * RETURNS A SECRET, which is why it is a separate function with a name that
 * says so rather than a field quietly added to the masked list. listApiKeys
 * exists precisely so an admin surface can show keys without touching a hash;
 * this is the one caller that genuinely needs one.
 *
 * The stored hash is the signing secret, deliberately. The agent can derive
 * the same value from the key it already holds, so a delegation is verifiable
 * without distributing a second credential that would then need its own
 * rotation story. It never leaves this process: it signs the body, and the
 * signature travels, not the secret.
 */
export async function getDelegationTarget(
  keyId: string,
  workspaceId: string,
): Promise<
  | { ok: true; keyId: string; workspaceId: string; agent: string; delegationUrl: string | null; capabilities: string[]; signingSecret: string }
  | { ok: false; reason: "not_found" | "revoked" }
> {
  const { rows } = await query<{
    id: string;
    workspace_id: string;
    agent: string;
    delegation_url: string | null;
    capabilities: string[] | null;
    key_hash: string;
    revoked_at: string | null;
  }>(
    `SELECT id, workspace_id, agent, delegation_url, capabilities, key_hash, revoked_at
       FROM instinct_gate_api_keys
      WHERE id = $1 AND workspace_id = $2`,
    [keyId, workspaceId],
  );

  const row = rows[0];
  if (!row) return { ok: false, reason: "not_found" };
  /* A revoked key is not a delegation target. Revocation has to mean the agent
     stops being part of the system, not merely that it stops being able to
     call in. */
  if (row.revoked_at) return { ok: false, reason: "revoked" };

  return {
    ok: true,
    keyId: row.id,
    workspaceId: row.workspace_id,
    agent: row.agent,
    delegationUrl: row.delegation_url,
    capabilities: row.capabilities ?? [],
    signingSecret: row.key_hash,
  };
}
