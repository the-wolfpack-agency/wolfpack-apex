/**
 * Signed telemetry ingest - verify that a forwarded batch came from a registered
 * source, not just anyone holding the shared token. Each source signs
 * `${timestamp}.${rawBody}` with its ES256 private key; we verify against the
 * registered public key and reject a signature that is stale (bounding replay).
 * Off by default (migration path); enforced when SITE_ANALYTICS_INGEST_SIGNING is
 * "on". Reuses the crypto layer's ES256 verify - no shared secret involved.
 */
import { hasDatabase, query, safeQuery } from "@/lib/db";
import { verifyEs256, type EcPublicJwk } from "@/lib/ogiam/signing";

/** Max age of a signed request, ms. Bounds signature replay. */
const MAX_SKEW_MS = 5 * 60 * 1000;

export function ingestSigningEnforced(): boolean {
  return process.env.SITE_ANALYTICS_INGEST_SIGNING === "on";
}

export async function getIngestSource(sourceId: string): Promise<{ algorithm: string; publicKey: Record<string, unknown> } | null> {
  if (!hasDatabase()) return null;
  const res = await safeQuery<{ algorithm: string; public_key: Record<string, unknown> }>(
    `SELECT algorithm, public_key FROM instinct_ingest_sources WHERE source_id = $1 LIMIT 1`,
    [sourceId],
  );
  const row = res.rows[0];
  return row ? { algorithm: row.algorithm, publicKey: row.public_key } : null;
}

export async function listIngestSources(): Promise<Array<{ sourceId: string; algorithm: string; createdAt: string }>> {
  if (!hasDatabase()) return [];
  const res = await safeQuery<{ source_id: string; algorithm: string; created_at: string }>(
    `SELECT source_id, algorithm, created_at FROM instinct_ingest_sources ORDER BY created_at DESC`,
  );
  return (res.rows ?? []).map((r) => ({ sourceId: r.source_id, algorithm: r.algorithm, createdAt: r.created_at }));
}

export async function registerIngestSource(input: { sourceId: string; publicKey: Record<string, unknown>; createdBy?: string }): Promise<void> {
  if (!hasDatabase()) return;
  await query(
    `INSERT INTO instinct_ingest_sources (source_id, algorithm, public_key, created_by)
     VALUES ($1, 'es256', $2, $3)
     ON CONFLICT (source_id) DO UPDATE SET public_key = EXCLUDED.public_key, updated_at = now()`,
    [input.sourceId, JSON.stringify(input.publicKey), input.createdBy ?? null],
  );
}

export interface IngestSignatureCheck {
  sourceId: string;
  timestamp: number; // epoch ms the client signed
  signature: string; // base64url ES256
  rawBody: string;
  nowMs: number;
}

/** Verify a signed ingest request. Fail-closed: unknown source, bad signature,
 *  or stale timestamp all return false. */
export async function verifyIngestSignature(input: IngestSignatureCheck): Promise<{ ok: boolean; reason?: string }> {
  if (!input.sourceId || !input.signature || !Number.isFinite(input.timestamp)) {
    return { ok: false, reason: "missing source, signature, or timestamp" };
  }
  if (Math.abs(input.nowMs - input.timestamp) > MAX_SKEW_MS) {
    return { ok: false, reason: "stale or future-dated signature" };
  }
  const source = await getIngestSource(input.sourceId);
  if (!source) return { ok: false, reason: "unregistered source" };
  const ok = verifyEs256(`${input.timestamp}.${input.rawBody}`, input.signature, source.publicKey as unknown as EcPublicJwk);
  return ok ? { ok: true } : { ok: false, reason: "signature did not verify" };
}
