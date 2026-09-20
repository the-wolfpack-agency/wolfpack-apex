/**
 * External audit anchoring (gap #7). Publishes the audit chain HEAD (seq +
 * entry_hash) to an external witness so a DB-admin compromise cannot rewrite
 * history undetectably: an auditor (or verifyExternalAnchors) compares the live
 * DB against what was published out-of-band. Best-effort on the external POST -
 * the security is the external copy; the local record is for verification and
 * display. Disabled (no-op) unless FORCEFIELD_AUDIT_ANCHOR_URL is configured.
 */
import { createHmac } from "node:crypto";
import { hasDatabase, query, safeQuery } from "@/lib/db";

export interface ChainHead { seq: number; entryHash: string; }
export interface AnchorDeps { fetchImpl?: typeof fetch; now?: () => number; }

export function auditAnchorConfigured(): boolean {
  return !!process.env.FORCEFIELD_AUDIT_ANCHOR_URL;
}

/** The current tip of the hash chain, or null if there are no entries. */
export async function getAuditChainHead(): Promise<ChainHead | null> {
  if (!hasDatabase()) return null;
  const res = await safeQuery<{ seq: string; entry_hash: string }>(
    `SELECT seq, entry_hash FROM instinct_audit_log ORDER BY seq DESC LIMIT 1`,
  );
  const row = res.rows[0];
  return row ? { seq: Number(row.seq), entryHash: row.entry_hash } : null;
}

/**
 * Publish the current chain head to the external witness and record it locally.
 * Signs the payload with FORCEFIELD_AUDIT_ANCHOR_SECRET so the witness can trust
 * it came from us. Returns the anchored head, or null when disabled / no entries.
 */
export async function publishAuditAnchor(deps: AnchorDeps = {}): Promise<{ seq: number; entryHash: string; delivered: boolean } | null> {
  const url = process.env.FORCEFIELD_AUDIT_ANCHOR_URL;
  if (!url || !hasDatabase()) return null;
  const head = await getAuditChainHead();
  if (!head) return null;

  const now = (deps.now ?? Date.now)();
  const body = JSON.stringify({ seq: head.seq, entryHash: head.entryHash, publishedAt: now });
  const secret = process.env.FORCEFIELD_AUDIT_ANCHOR_SECRET || "";
  const signature = secret ? createHmac("sha256", secret).update(body).digest("hex") : "";

  let delivered = false;
  let receipt: string | null = null;
  try {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", "x-anchor-signature": signature }, body });
    delivered = res.ok;
    receipt = res.ok ? (res.headers.get("x-anchor-receipt") || "delivered") : null;
  } catch {
    delivered = false; // best-effort: still record locally that we TRIED at this head
  }

  await query(
    `INSERT INTO instinct_audit_external_anchors (seq, entry_hash, target, receipt) VALUES ($1, $2, $3, $4)`,
    [head.seq, head.entryHash, url, receipt],
  ).catch(() => {});

  return { seq: head.seq, entryHash: head.entryHash, delivered };
}

export interface AnchorVerifyResult {
  checked: number;
  matches: number;
  /** Seqs whose live DB hash no longer matches what we anchored - tamper. */
  mismatches: number[];
  ok: boolean;
}

/**
 * Verify the live DB against every externally-published anchor. For each anchor,
 * re-read the audit entry at that seq and confirm its hash still matches. A
 * mismatch means a row was rewritten after we published it - tamper detected.
 */
export async function verifyExternalAnchors(): Promise<AnchorVerifyResult> {
  if (!hasDatabase()) return { checked: 0, matches: 0, mismatches: [], ok: true };
  const anchors = await safeQuery<{ seq: string; entry_hash: string }>(
    `SELECT seq, entry_hash FROM instinct_audit_external_anchors ORDER BY seq`,
  );
  let matches = 0;
  const mismatches: number[] = [];
  for (const a of anchors.rows) {
    const live = await safeQuery<{ entry_hash: string }>(
      `SELECT entry_hash FROM instinct_audit_log WHERE seq = $1 LIMIT 1`,
      [Number(a.seq)],
    );
    const liveHash = live.rows[0]?.entry_hash;
    if (liveHash && liveHash === a.entry_hash) matches += 1;
    else mismatches.push(Number(a.seq));
  }
  return { checked: anchors.rows.length, matches, mismatches, ok: mismatches.length === 0 };
}

export async function anchorStatus(): Promise<{ configured: boolean; count: number; lastSeq: number | null }> {
  if (!hasDatabase()) return { configured: auditAnchorConfigured(), count: 0, lastSeq: null };
  const res = await safeQuery<{ n: string; last_seq: string | null }>(
    `SELECT count(*) AS n, max(seq) AS last_seq FROM instinct_audit_external_anchors`,
  );
  const row = res.rows[0];
  return { configured: auditAnchorConfigured(), count: Number(row?.n ?? 0), lastSeq: row?.last_seq != null ? Number(row.last_seq) : null };
}
