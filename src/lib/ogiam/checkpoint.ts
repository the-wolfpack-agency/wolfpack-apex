/**
 * OGIAM chain verification and checkpoint notarization.
 *
 * verifyChain recomputes every entry_hash from the stored canonical payload and
 * checks the per-row linkage, so any after-the-fact edit or deletion is
 * detected. createCheckpoint signs the current chain head (one signature
 * anchoring all decisions up to that point) with the configured signer, and
 * records it. The cron sweep checkpoints every workspace that has new decisions.
 *
 * All reads use safeQuery and degrade gracefully; the signing call is best
 * effort (a null signature still records a checkpoint marking the chain as
 * tamper-evident but not yet notarized).
 */

import { createHash } from "crypto";
import { query, safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { OGIAM_GENESIS_HASH } from "./ledger";
import { checkpointPayload, getSigner, type OgiamSigner } from "./signing";

export interface ChainVerification {
  ok: boolean;
  /** Rows whose hash + linkage were recomputed and matched. */
  verifiedCount: number;
  /** Rows written before hash_payload existed; linkage checked, hash not
   *  independently recomputable. */
  legacyCount: number;
  /** First sequence number where the chain failed, if any. */
  brokenAtSeq: number | null;
  headSeq: number;
  headHash: string | null;
}

interface ChainRow {
  seq: string;
  prev_hash: string;
  entry_hash: string;
  hash_payload: string | null;
}

/** Recompute and verify the entire decision chain for a workspace. */
export async function verifyChain(workspaceId: string): Promise<ChainVerification> {
  const res = await safeQuery<ChainRow>(
    `SELECT seq, prev_hash, entry_hash, hash_payload
       FROM ogiam_decisions WHERE workspace_id = $1 ORDER BY seq ASC`,
    [workspaceId],
  );
  const rows = res.rows;

  let expectedPrev = OGIAM_GENESIS_HASH;
  let verifiedCount = 0;
  let legacyCount = 0;
  let brokenAtSeq: number | null = null;
  let headHash: string | null = null;
  let headSeq = 0;

  for (const row of rows) {
    const seq = Number(row.seq);
    headSeq = seq;
    headHash = row.entry_hash;

    // Linkage: this row's prev_hash must equal the previous row's entry_hash.
    if (row.prev_hash !== expectedPrev) {
      brokenAtSeq = seq;
      return { ok: false, verifiedCount, legacyCount, brokenAtSeq, headSeq, headHash };
    }

    if (row.hash_payload != null) {
      const recomputed = createHash("sha256")
        .update(row.prev_hash)
        .update("|")
        .update(row.hash_payload)
        .digest("hex");
      if (recomputed !== row.entry_hash) {
        brokenAtSeq = seq;
        return { ok: false, verifiedCount, legacyCount, brokenAtSeq, headSeq, headHash };
      }
      verifiedCount += 1;
    } else {
      legacyCount += 1;
    }
    expectedPrev = row.entry_hash;
  }

  return { ok: brokenAtSeq === null, verifiedCount, legacyCount, brokenAtSeq, headSeq, headHash };
}

export interface OgiamCheckpoint {
  id: string;
  workspaceId: string;
  throughSeq: number;
  headHash: string;
  algorithm: string;
  keyId: string;
  signed: boolean;
  signedAt: string | null;
  createdAt: string;
}

/** The latest checkpoint for a workspace, or null. */
export async function latestCheckpoint(
  workspaceId: string,
): Promise<OgiamCheckpoint | null> {
  const res = await safeQuery<Record<string, unknown>>(
    `SELECT id, workspace_id, through_seq, head_hash, algorithm, key_id,
            signature, signed_at::text AS signed_at, created_at::text AS created_at
       FROM ogiam_checkpoints WHERE workspace_id = $1
      ORDER BY through_seq DESC LIMIT 1`,
    [workspaceId],
  );
  const r = res.rows[0];
  if (!r) return null;
  return mapCheckpoint(r);
}

function mapCheckpoint(r: Record<string, unknown>): OgiamCheckpoint {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    throughSeq: Number(r.through_seq),
    headHash: String(r.head_hash),
    algorithm: String(r.algorithm),
    keyId: String(r.key_id),
    signed: r.signature != null,
    signedAt: (r.signed_at as string | null) ?? null,
    createdAt: String(r.created_at),
  };
}

/** Workspaces with at least one decision beyond their latest checkpoint. */
export async function workspacesNeedingCheckpoint(): Promise<string[]> {
  const res = await safeQuery<{ workspace_id: string }>(
    `SELECT d.workspace_id
       FROM (SELECT workspace_id, MAX(seq) AS max_seq FROM ogiam_decisions GROUP BY workspace_id) d
       LEFT JOIN (SELECT workspace_id, MAX(through_seq) AS max_cp FROM ogiam_checkpoints GROUP BY workspace_id) c
         ON c.workspace_id = d.workspace_id
      WHERE c.max_cp IS NULL OR d.max_seq > c.max_cp`,
  );
  return res.rows.map((r) => r.workspace_id);
}

/**
 * Sign and record a checkpoint over the current chain head for a workspace.
 * Returns null when there is nothing new to checkpoint. Verifies the chain
 * first; refuses to notarize a chain that does not verify.
 */
export async function createCheckpoint(
  workspaceId: string,
  signer: OgiamSigner = getSigner(),
): Promise<OgiamCheckpoint | null> {
  const head = await safeQuery<{ seq: string; entry_hash: string }>(
    `SELECT seq, entry_hash FROM ogiam_decisions
      WHERE workspace_id = $1 ORDER BY seq DESC LIMIT 1`,
    [workspaceId],
  );
  const headRow = head.rows[0];
  if (!headRow) return null;
  const throughSeq = Number(headRow.seq);
  const headHash = headRow.entry_hash;

  const last = await latestCheckpoint(workspaceId);
  if (last && last.throughSeq >= throughSeq) return null; // nothing new

  // Never notarize a chain that does not verify.
  const verification = await verifyChain(workspaceId);
  if (!verification.ok) {
    trackEvent("ogiam.checkpoint_signed", "system", "system", {
      workspace_id: workspaceId,
      through_seq: throughSeq,
      signed: false,
      chain_ok: false,
      broken_at_seq: verification.brokenAtSeq ?? -1,
    });
    return null;
  }

  const payload = checkpointPayload(workspaceId, throughSeq, headHash);
  const sig = await signer.sign(payload);
  const signedAt = sig.signature ? new Date().toISOString() : null;

  const inserted = await query<{ id: string; created_at: string }>(
    `INSERT INTO ogiam_checkpoints
       (workspace_id, through_seq, head_hash, payload, algorithm, key_id, signature, signed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (workspace_id, through_seq) DO NOTHING
     RETURNING id, created_at::text AS created_at`,
    [workspaceId, throughSeq, headHash, payload, sig.algorithm, sig.keyId, sig.signature, signedAt],
  );
  const row = inserted.rows[0];
  if (!row) return null; // a concurrent sweep already wrote this checkpoint

  trackEvent("ogiam.checkpoint_signed", "system", "system", {
    workspace_id: workspaceId,
    through_seq: throughSeq,
    algorithm: sig.algorithm,
    key_id: sig.keyId,
    signed: Boolean(sig.signature),
    chain_ok: true,
    verified_count: verification.verifiedCount,
  });

  return {
    id: row.id,
    workspaceId,
    throughSeq,
    headHash,
    algorithm: sig.algorithm,
    keyId: sig.keyId,
    signed: Boolean(sig.signature),
    signedAt,
    createdAt: row.created_at,
  };
}

/** Checkpoint every workspace that has new decisions. Returns the count
 *  written. Best effort per workspace. */
export async function runCheckpointSweep(
  signer: OgiamSigner = getSigner(),
): Promise<{ workspaces: number; written: number }> {
  const workspaces = await workspacesNeedingCheckpoint();
  let written = 0;
  for (const ws of workspaces) {
    try {
      const cp = await createCheckpoint(ws, signer);
      if (cp) written += 1;
    } catch (err) {
      console.warn(`[ogiam] checkpoint failed for ${ws}:`, (err as Error).message);
    }
  }
  return { workspaces: workspaces.length, written };
}
