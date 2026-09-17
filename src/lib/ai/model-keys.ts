/**
 * Bring-your-own model keys - per-workspace, encrypted at rest.
 *
 * A customer plugs in their own provider API key so THEIR model runs the
 * authoring / repair / judge work, while our deterministic gate governs it
 * unchanged. That is the whole model-agnostic pitch, so the storage has one job:
 * hold the key safely and hand the PLAINTEXT to nothing but the router.
 *
 * Security invariants (enforced + tested):
 *   - The key is encrypted with AES-256-GCM (secret-storage) BEFORE it touches
 *     the database; the column never holds plaintext.
 *   - `listModelKeys` returns only a last-4 hint - never the key, never the
 *     ciphertext - so it is safe to render.
 *   - `getDecryptedModelKey` is the ONLY path back to plaintext, used by the
 *     router to authenticate the model, and is never wired to a response body.
 */
import { query, safeQuery } from "@/lib/db";
import { encryptSecret, decryptSecret } from "@/lib/crypto/secret-storage";
import { trackEvent } from "@/lib/analytics";

export type ModelProvider = "anthropic" | "openai" | "azure" | "foundry";
export const MODEL_PROVIDERS: readonly ModelProvider[] = ["anthropic", "openai", "azure", "foundry"];

export function isModelProvider(v: unknown): v is ModelProvider {
  return typeof v === "string" && (MODEL_PROVIDERS as readonly string[]).includes(v);
}

/** Safe to render: carries a display hint, never the key or the ciphertext. */
export interface ModelKeySummary {
  id: string;
  provider: ModelProvider;
  label: string | null;
  keyHint: string;
  createdAt: string;
}

/** A masked hint - the last 4 characters only, so a person can recognise which
 *  key is stored without the key ever leaving the store. */
function hintOf(key: string): string {
  const tail = key.slice(-4);
  return `****${tail}`;
}

/**
 * Store (or rotate) a provider key for a workspace. Encrypts before persisting;
 * returns a summary that NEVER includes the key. Best-effort without a database.
 */
export async function setModelKey(input: {
  workspaceId: string;
  provider: ModelProvider;
  label?: string | null;
  plaintextKey: string;
  createdBy?: string;
}): Promise<ModelKeySummary | null> {
  if (!process.env.DATABASE_URL) return null;
  const key = (input.plaintextKey ?? "").trim();
  if (!key) throw new Error("plaintextKey is required");
  if (!isModelProvider(input.provider)) throw new Error(`unknown provider: ${input.provider}`);

  const encrypted = encryptSecret(key); // AES-256-GCM v1 token; never the plaintext
  const hint = hintOf(key);

  const { rows } = await query<{ id: string; created_at: string }>(
    `INSERT INTO instinct_workspace_model_keys
       (workspace_id, provider, label, encrypted_key, key_hint, created_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (workspace_id, provider)
       DO UPDATE SET label = EXCLUDED.label, encrypted_key = EXCLUDED.encrypted_key,
                     key_hint = EXCLUDED.key_hint, created_by = EXCLUDED.created_by, updated_at = now()
     RETURNING id, created_at::text AS created_at`,
    [input.workspaceId, input.provider, input.label ?? null, encrypted, hint, input.createdBy ?? null],
  );
  const row = rows[0];
  if (!row) return null;

  trackEvent("ai_code.model_key_set", input.createdBy ?? "system", "agent", {
    workspace_id: input.workspaceId,
    provider: input.provider,
  });

  return { id: row.id, provider: input.provider, label: input.label ?? null, keyHint: hint, createdAt: row.created_at };
}

/** List a workspace's stored keys. SAFE for a response body: hint only. */
export async function listModelKeys(workspaceId: string): Promise<ModelKeySummary[]> {
  const res = await safeQuery<{
    id: string;
    provider: ModelProvider;
    label: string | null;
    key_hint: string;
    created_at: string;
  }>(
    `SELECT id, provider, label, key_hint, created_at::text AS created_at
       FROM instinct_workspace_model_keys
      WHERE workspace_id = $1
      ORDER BY provider`,
    [workspaceId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    label: r.label,
    keyHint: r.key_hint,
    createdAt: r.created_at,
  }));
}

/**
 * INTERNAL ONLY. The decrypted key, for the router to authenticate the model.
 * Returns null when there is no key or it cannot be decrypted (fail-closed). Do
 * NOT wire this to any list / response surface.
 */
export async function getDecryptedModelKey(
  workspaceId: string,
  provider: ModelProvider,
): Promise<string | null> {
  const res = await safeQuery<{ encrypted_key: string }>(
    `SELECT encrypted_key FROM instinct_workspace_model_keys
      WHERE workspace_id = $1 AND provider = $2`,
    [workspaceId, provider],
  );
  const enc = res.rows[0]?.encrypted_key;
  return enc ? decryptSecret(enc) : null;
}

/** Remove a stored key. Best-effort without a database. */
export async function deleteModelKey(workspaceId: string, id: string): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  const res = await query(
    `DELETE FROM instinct_workspace_model_keys WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id],
  );
  return (res.rowCount ?? 0) > 0;
}
