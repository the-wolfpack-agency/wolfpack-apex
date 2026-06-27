/**
 * Instinct Audit Log — compliance-grade, append-only, hash-chained.
 *
 * Distinct from analytics events (src/lib/analytics.ts):
 *   - Analytics = observability (counts, behavior signals, learning loop)
 *   - Audit     = compliance record (who/what/when/where/before/after)
 *
 * Guarantees:
 *   - APPEND ONLY: UPDATE/DELETE blocked at DB layer (trigger in migration 019)
 *   - TAMPER EVIDENT: each row hashes prev row's hash + its own canonical JSON
 *   - PII REDACTED before hashing and before storage
 *   - DETERMINISTIC HASH: canonical JSON with sorted keys so verifyChain is
 *     reproducible across machines
 *
 * Hash chain formula:
 *   entry_hash = sha256(prev_hash || canonical_json(fields_excluding_hashes))
 *   For seq = 1, prev_hash = GENESIS_HASH constant.
 *
 * Threading / concurrency: recordAudit serializes every append GLOBALLY with a
 * transaction-scoped Postgres advisory lock (pg_advisory_xact_lock) taken on a
 * single fixed key (AUDIT_CHAIN_LOCK_KEY) immediately after BEGIN. This makes
 * the "read latest -> compute prev_hash -> insert next" sequence atomic per
 * chain: no two transactions can both observe the same latest row and fork the
 * chain. The lock auto-releases at COMMIT/ROLLBACK (no leak on error path).
 *
 * Why an advisory lock and NOT `BEGIN ISOLATION LEVEL SERIALIZABLE` + retry:
 *   - SERIALIZABLE detects the conflict only AFTER the fact and raises a
 *     serialization_failure (SQLSTATE 40001) that the caller must catch and
 *     RETRY in a loop. recordAudit sits on hot mutation paths (HR edits, auth
 *     events); surfacing 40001 there means every call site needs retry logic or
 *     audit writes start failing under load — exactly when we most need them.
 *   - The advisory lock instead makes appends WAIT their turn and proceed in a
 *     total order. No retry loop, no serialization-failure surface, and a global
 *     ordering guarantee for the single-writer chain. Append throughput is
 *     bounded by the lock, which is acceptable: the audit chain is intentionally
 *     a single linear log, not a high-fan-out hot table.
 * The historical bug (chain fork at seq 509) was a READ-COMMITTED `FOR UPDATE`
 * on the latest row: under contention two txns both re-evaluated row 508 (not
 * the freshly-committed 509) and computed prev_hash off the wrong predecessor.
 */

import { createHash } from "crypto";
import type { PoolClient } from "pg";
import { pool, safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditActor {
  user_id: string;
  role: string;
}

export interface AuditEntryInput {
  actor: AuditActor;
  action: string; // e.g. "hr.employee.updated"
  resourceType: string; // e.g. "employee"
  resourceId?: string;
  beforeState?: unknown;
  afterState?: unknown;
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}

export interface AuditEntry {
  id: string;
  seq: number;
  ts: string;
  actor: AuditActor;
  action: string;
  resourceType: string;
  resourceId: string | null;
  beforeState: unknown;
  afterState: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
  prevHash: string | null;
  entryHash: string;
}

export interface RecordResult {
  id: string;
  seq: number;
  entryHash: string;
}

export interface VerifyResult {
  valid: boolean;
  brokenAt?: number;
  checkedCount: number;
  reason?: string;
  /**
   * Acknowledged re-anchor seqs that verifyChain honored within the scanned
   * range. A prev_hash mismatch AT one of these seqs is an expected new-segment
   * genesis (a legitimate, operator-acknowledged break) and does NOT fail
   * verification. Present so callers can show "verified across N anchors".
   */
  honoredAnchors?: number[];
}

export interface QueryFilter {
  actorUserId?: string;
  resourceType?: string;
  resourceId?: string;
  action?: string;
  since?: Date;
  until?: Date;
  limit?: number;
  cursor?: string; // base64-encoded seq
}

export interface QueryResultPage {
  entries: AuditEntry[];
  nextCursor?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GENESIS_HASH = "instinct:audit:genesis";

/**
 * Fixed advisory-lock key for the audit chain. A single stable bigint shared by
 * every recordAudit transaction so all appends serialize against ONE lock and
 * the chain can never fork. The value is arbitrary but MUST never change — it is
 * the chain's global mutex identity. (Chosen as a fixed constant, not derived,
 * so it is greppable and collision-free against any other advisory-lock user.)
 */
export const AUDIT_CHAIN_LOCK_KEY = 778_021_509 as const;

/**
 * Sensitive field registry. Any key matching (case-insensitive) in before/after
 * state will be replaced with "[REDACTED]" BEFORE hashing and BEFORE storage.
 *
 * Add new fields here, not at individual call-sites. Centralized redaction
 * prevents drift.
 */
export const PII_FIELDS: ReadonlyArray<string> = [
  "ssn",
  "ssnLast4",
  "ssn_last4",
  "bankAccount",
  "bank_account",
  "routingNumber",
  "routing_number",
  "dateOfBirth",
  "date_of_birth",
  "dob",
  "driversLicense",
  "drivers_license",
  "passport",
  "passportNumber",
  "passport_number",
  "password",
  "passwordHash",
  "password_hash",
];

const PII_SET = new Set(PII_FIELDS.map((f) => f.toLowerCase()));
const REDACTION_MAX_DEPTH = 8;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

// Sample rate for meta-event `system.audit_log_written` to avoid flooding
// analytics in high-write scenarios. 1-in-N. Set to 1 in tests via the export.
let AUDIT_META_SAMPLE_N = 20;
export function _setAuditMetaSampleRateForTests(n: number): void {
  AUDIT_META_SAMPLE_N = Math.max(1, n);
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Walk a value and replace any PII-keyed field with "[REDACTED]".
 * Depth-limited to defend against cyclic / adversarial payloads.
 */
export function redactPII(value: unknown, depth = 0): unknown {
  if (depth > REDACTION_MAX_DEPTH) return "[TRUNCATED]";
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((v) => redactPII(v, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PII_SET.has(k.toLowerCase())) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactPII(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Canonical JSON (sorted keys) — reproducible hash input
// ---------------------------------------------------------------------------

export function canonicalJSON(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Hash
// ---------------------------------------------------------------------------

interface HashableRow {
  seq: number;
  ts: string;
  actor_user_id: string;
  actor_role: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  before_state: unknown;
  after_state: unknown;
  ip_address: string | null;
  user_agent: string | null;
  request_id: string | null;
}

export function computeEntryHash(prevHash: string, row: HashableRow): string {
  const payload = canonicalJSON(row);
  return createHash("sha256").update(prevHash).update("|").update(payload).digest("hex");
}

// ---------------------------------------------------------------------------
// recordAudit
// ---------------------------------------------------------------------------

/**
 * Append one audit entry. Redacts PII, fetches prev hash, computes new hash,
 * inserts atomically. Returns the generated id / seq / hash.
 *
 * In shadow mode (no DATABASE_URL) this is a no-op returning synthetic values
 * so callers need not branch.
 */
export async function recordAudit(entry: AuditEntryInput): Promise<RecordResult> {
  if (!process.env.DATABASE_URL) {
    return {
      id: "shadow",
      seq: 0,
      entryHash: GENESIS_HASH,
    };
  }

  const redactedBefore = entry.beforeState === undefined ? null : redactPII(entry.beforeState);
  const redactedAfter = entry.afterState === undefined ? null : redactPII(entry.afterState);

  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");

    // Serialize ALL audit appends globally. Transaction-scoped advisory lock on
    // the single fixed chain key: every concurrent recordAudit waits here, so
    // the read-latest -> compute prev_hash -> insert sequence below is atomic
    // and the chain can never fork (the seq 509 bug). Auto-released at
    // COMMIT/ROLLBACK. See the file header for why this over SERIALIZABLE+retry.
    await client.query("SELECT pg_advisory_xact_lock($1)", [AUDIT_CHAIN_LOCK_KEY]);

    // The advisory lock is the real serializer; FOR UPDATE is dropped. Under the
    // old READ-COMMITTED FOR UPDATE, a waiter re-evaluated the SAME stale row
    // after the lock released and computed prev_hash off the wrong predecessor.
    // With the chain held by ONE lock for the whole txn, the latest row we read
    // here is guaranteed to be the true tail.
    const prev = await client.query<{ entry_hash: string; seq: string }>(
      `SELECT entry_hash, seq FROM instinct_audit_log
       ORDER BY seq DESC LIMIT 1`,
    );

    const prevHash = prev.rows.length > 0 ? prev.rows[0].entry_hash : GENESIS_HASH;

    // Insert placeholder hash, then compute + update? No — that would violate
    // append-only (UPDATE is blocked). Strategy: reserve the next seq by
    // inserting, then compute hash. But we need the hash in the insert.
    //
    // Solution: use nextval() to reserve a seq, then compute hash against a
    // row that includes that seq, then insert with the known hash.
    const seqResult = await client.query<{ nextval: string }>(
      `SELECT nextval('instinct_audit_log_seq_seq') AS nextval`,
    );
    const seq = Number(seqResult.rows[0].nextval);
    const ts = new Date().toISOString();

    const hashInput: HashableRow = {
      seq,
      ts,
      actor_user_id: entry.actor.user_id,
      actor_role: entry.actor.role,
      action: entry.action,
      resource_type: entry.resourceType,
      resource_id: entry.resourceId ?? null,
      before_state: redactedBefore,
      after_state: redactedAfter,
      ip_address: entry.ipAddress ?? null,
      user_agent: entry.userAgent ?? null,
      request_id: entry.requestId ?? null,
    };

    const entryHash = computeEntryHash(prevHash, hashInput);

    const insert = await client.query<{ id: string }>(
      `INSERT INTO instinct_audit_log
         (seq, ts, actor_user_id, actor_role, action, resource_type, resource_id,
          before_state, after_state, ip_address, user_agent, request_id,
          prev_hash, entry_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14)
       RETURNING id`,
      [
        seq,
        ts,
        entry.actor.user_id,
        entry.actor.role,
        entry.action,
        entry.resourceType,
        entry.resourceId ?? null,
        redactedBefore === null ? null : JSON.stringify(redactedBefore),
        redactedAfter === null ? null : JSON.stringify(redactedAfter),
        entry.ipAddress ?? null,
        entry.userAgent ?? null,
        entry.requestId ?? null,
        prevHash === GENESIS_HASH ? null : prevHash,
        entryHash,
      ],
    );

    await client.query("COMMIT");

    // Sampled meta-event. Fire-and-forget.
    if (seq % AUDIT_META_SAMPLE_N === 0) {
      trackEvent("system.audit_log_written", entry.actor.user_id, entry.actor.role, {
        seq,
        action: entry.action,
        resource_type: entry.resourceType,
      });
    }

    return { id: insert.rows[0].id, seq, entryHash };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// verifyChain
// ---------------------------------------------------------------------------

/**
 * Walk the chain from `fromSeq` (default 1) to `toSeq` (default MAX) and
 * recompute each entry's hash; return brokenAt on first mismatch.
 */
export async function verifyChain(fromSeq?: number, toSeq?: number): Promise<VerifyResult> {
  if (!process.env.DATABASE_URL) {
    return { valid: true, checkedCount: 0, reason: "shadow_mode" };
  }

  // Load acknowledged re-anchor seqs FIRST. A prev_hash mismatch AT an anchored
  // seq is a legitimate new-segment genesis (e.g. the seq-509 concurrency fork
  // an admin cleared) and must NOT fail verification. An UNanchored prev_hash
  // mismatch, or ANY entry_hash (content) mismatch, still fails — tamper stays
  // detectable.
  const { rows: anchorRows } = await safeQuery<{ seq: string }>(
    `SELECT seq FROM instinct_audit_chain_anchors`,
  );
  const anchoredSeqs = new Set<number>(anchorRows.map((r) => Number(r.seq)));
  const honoredAnchors: number[] = [];

  const from = Math.max(1, fromSeq ?? 1);
  const params: unknown[] = [from];
  let where = "seq >= $1";
  if (toSeq !== undefined) {
    where += " AND seq <= $2";
    params.push(toSeq);
  }

  const { rows } = await safeQuery<{
    seq: string;
    ts: string;
    actor_user_id: string;
    actor_role: string;
    action: string;
    resource_type: string;
    resource_id: string | null;
    before_state: unknown;
    after_state: unknown;
    ip_address: string | null;
    user_agent: string | null;
    request_id: string | null;
    prev_hash: string | null;
    entry_hash: string;
  }>(
    `SELECT seq, ts, actor_user_id, actor_role, action, resource_type, resource_id,
            before_state, after_state, ip_address, user_agent, request_id,
            prev_hash, entry_hash
     FROM instinct_audit_log
     WHERE ${where}
     ORDER BY seq ASC`,
    params,
  );

  let expectedPrev: string;
  if (from === 1) {
    expectedPrev = GENESIS_HASH;
  } else {
    const { rows: prior } = await safeQuery<{ entry_hash: string }>(
      `SELECT entry_hash FROM instinct_audit_log WHERE seq = $1`,
      [from - 1],
    );
    expectedPrev = prior.length > 0 ? prior[0].entry_hash : GENESIS_HASH;
  }

  let checked = 0;
  for (const row of rows) {
    const seq = Number(row.seq);

    // prev_hash column must match expectedPrev (null means genesis).
    const storedPrev = row.prev_hash ?? GENESIS_HASH;
    if (storedPrev !== expectedPrev) {
      if (anchoredSeqs.has(seq)) {
        // Acknowledged re-anchor: this seq begins a NEW segment. Adopt the row's
        // own stored prev_hash as the segment genesis and keep verifying so the
        // rest of the chain (and this row's own content hash, below) is still
        // checked against THIS row's recorded predecessor.
        honoredAnchors.push(seq);
        expectedPrev = storedPrev;
      } else {
        return {
          valid: false,
          brokenAt: seq,
          checkedCount: checked,
          reason: "prev_hash_mismatch",
          honoredAnchors,
        };
      }
    }

    const expectedHash = computeEntryHash(expectedPrev, {
      seq,
      ts: typeof row.ts === "string" ? row.ts : new Date(row.ts).toISOString(),
      actor_user_id: row.actor_user_id,
      actor_role: row.actor_role,
      action: row.action,
      resource_type: row.resource_type,
      resource_id: row.resource_id,
      before_state: row.before_state,
      after_state: row.after_state,
      ip_address: row.ip_address,
      user_agent: row.user_agent,
      request_id: row.request_id,
    });

    if (expectedHash !== row.entry_hash) {
      // Content tamper: even at an anchored seq, the row's OWN hash must match
      // its recorded fields + prev_hash. An anchor excuses a chain break, never
      // a rewritten row. This is what keeps tampering detectable post-reanchor.
      return {
        valid: false,
        brokenAt: seq,
        checkedCount: checked,
        reason: "entry_hash_mismatch",
        honoredAnchors,
      };
    }

    expectedPrev = row.entry_hash;
    checked++;
  }

  return { valid: true, checkedCount: checked, honoredAnchors };
}

// ---------------------------------------------------------------------------
// reanchorChain — acknowledge a known, non-tamper chain break
// ---------------------------------------------------------------------------

export interface ReanchorResult {
  seq: number;
  reason: string;
  acknowledgedBy: string;
  /** true if this seq was already anchored (idempotent re-ack). */
  alreadyAnchored: boolean;
}

/**
 * Record an acknowledged re-anchor at `seq`. After this, verifyChain treats a
 * prev_hash mismatch AT `seq` as an expected new-segment genesis instead of a
 * tamper signal. This NEVER rewrites instinct_audit_log rows — history stays
 * intact and tamper-evident; we only annotate a known break as acknowledged.
 *
 * Idempotent: re-anchoring an already-anchored seq is a no-op success
 * (UNIQUE(seq) on the anchors table). The action is itself audited (hash-chained
 * meta entry, no secrets) and emits a learning-loop analytics event.
 */
export async function reanchorChain(
  seq: number,
  reason: string,
  by: AuditActor,
): Promise<ReanchorResult> {
  if (!process.env.DATABASE_URL) {
    return { seq, reason, acknowledgedBy: by.user_id, alreadyAnchored: false };
  }

  // ON CONFLICT DO NOTHING => idempotent. xmax = 0 on the returned row means a
  // fresh insert; no returned row means the seq was already anchored.
  const { rows } = await safeQuery<{ seq: string }>(
    `INSERT INTO instinct_audit_chain_anchors (seq, reason, acknowledged_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (seq) DO NOTHING
     RETURNING seq`,
    [seq, reason, by.user_id],
  );
  const alreadyAnchored = rows.length === 0;

  // Audit the re-anchor itself — meta only, no secrets. The afterState records
  // WHAT was acknowledged and WHY so the action is itself tamper-evident.
  await recordAudit({
    actor: by,
    action: "audit.chain.reanchored",
    resourceType: "audit_chain",
    resourceId: String(seq),
    afterState: { seq, reason, already_anchored: alreadyAnchored },
  });

  // Learning loop: surface that a known break was acknowledged.
  trackEvent("system.audit_log_reanchored", by.user_id, by.role, {
    seq,
    reason,
    already_anchored: alreadyAnchored,
  });

  return { seq, reason, acknowledgedBy: by.user_id, alreadyAnchored };
}

// ---------------------------------------------------------------------------
// analyzeChain + reconcileChain: drain legacy concurrency forks in one pass
// ---------------------------------------------------------------------------

export interface ChainAnalysis {
  /** true only when there are NO forks and NO tampers across the whole chain. */
  valid: boolean;
  checkedCount: number;
  /**
   * Seqs where the chain LINKAGE broke but the row's own entry_hash is valid
   * against its OWN stored prev_hash. That is the concurrency-fork signature:
   * the row is cryptographically authentic, it was just linked to a stale
   * predecessor by the pre-advisory-lock race. These are safe to acknowledge.
   */
  forkSeqs: number[];
  /**
   * Seqs whose entry_hash does NOT match a recompute over their own recorded
   * fields + stored prev_hash. That is content tampering (a rewritten row) and
   * is NEVER auto-acknowledged: it is the real break-glass signal.
   */
  tamperSeqs: number[];
  /** Of forkSeqs, the ones already acknowledged in instinct_audit_chain_anchors. */
  alreadyAnchored: number[];
}

interface ChainRow {
  seq: string;
  ts: string;
  actor_user_id: string;
  actor_role: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  before_state: unknown;
  after_state: unknown;
  ip_address: string | null;
  user_agent: string | null;
  request_id: string | null;
  prev_hash: string | null;
  entry_hash: string;
}

function recomputeRowHash(prevHash: string, row: ChainRow): string {
  return computeEntryHash(prevHash, {
    seq: Number(row.seq),
    ts: typeof row.ts === "string" ? row.ts : new Date(row.ts).toISOString(),
    actor_user_id: row.actor_user_id,
    actor_role: row.actor_role,
    action: row.action,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    before_state: row.before_state,
    after_state: row.after_state,
    ip_address: row.ip_address,
    user_agent: row.user_agent,
    request_id: row.request_id,
  });
}

/**
 * Walk the WHOLE chain and classify every break, instead of stopping at the
 * first like verifyChain. This is what turns one-mismatch-at-a-time re-anchoring
 * (whack-a-mole: anchoring seq 509 just reveals the next legacy fork at 1216)
 * into a single, complete picture: every authentic concurrency fork AND every
 * genuine tamper in one pass. A break is a fork iff the row hashes correctly to
 * its own stored prev_hash (authentic, mis-linked); otherwise it is a tamper.
 */
export async function analyzeChain(): Promise<ChainAnalysis> {
  if (!process.env.DATABASE_URL) {
    return { valid: true, checkedCount: 0, forkSeqs: [], tamperSeqs: [], alreadyAnchored: [] };
  }

  const { rows: anchorRows } = await safeQuery<{ seq: string }>(
    `SELECT seq FROM instinct_audit_chain_anchors`,
  );
  const anchored = new Set<number>(anchorRows.map((r) => Number(r.seq)));

  const { rows } = await safeQuery<ChainRow>(
    `SELECT seq, ts, actor_user_id, actor_role, action, resource_type, resource_id,
            before_state, after_state, ip_address, user_agent, request_id,
            prev_hash, entry_hash
       FROM instinct_audit_log
      ORDER BY seq ASC`,
  );

  let expectedPrev = GENESIS_HASH;
  let checked = 0;
  const forkSeqs: number[] = [];
  const tamperSeqs: number[] = [];
  const alreadyAnchored: number[] = [];

  for (const row of rows) {
    const seq = Number(row.seq);
    const storedPrev = row.prev_hash ?? GENESIS_HASH;
    // Recompute using the row's OWN stored prev_hash: this asks "is this row
    // internally authentic?" independent of where it sits in the chain.
    const selfValid = recomputeRowHash(storedPrev, row) === row.entry_hash;

    if (storedPrev !== expectedPrev) {
      // Linkage broke at this seq.
      if (selfValid) {
        forkSeqs.push(seq);
        if (anchored.has(seq)) alreadyAnchored.push(seq);
      } else {
        tamperSeqs.push(seq);
      }
    } else if (!selfValid) {
      // Linkage intact but the row does not hash to its content: tamper.
      tamperSeqs.push(seq);
    }

    // Continue from this row's recorded hash so the next row is judged against
    // its actual predecessor (segments resume cleanly after an authentic fork).
    expectedPrev = row.entry_hash;
    checked++;
  }

  return {
    valid: forkSeqs.length === 0 && tamperSeqs.length === 0,
    checkedCount: checked,
    forkSeqs,
    tamperSeqs,
    alreadyAnchored,
  };
}

export interface ReconcileResult {
  /** New anchors written this run (already-anchored forks are not recounted). */
  reconciled: number;
  /** Every authentic fork seq found (incl. ones already anchored before this run). */
  forkSeqs: number[];
  /** Only the seqs newly anchored this run. Matches `reconciled`; use this for
   *  user-facing messaging so the listed seqs equal the reported count. */
  newlyReconciledSeqs: number[];
  tamperSeqs: number[];
  /** true when tampers were present, so NOTHING was anchored. */
  refused: boolean;
  checkedCount: number;
}

/**
 * Acknowledge every authentic concurrency fork in one operation, so the chain
 * verifies clean again without papering over anything. SAFETY: if analyzeChain
 * finds ANY genuine tamper, this anchors NOTHING and returns refused=true: a
 * real rewritten row must reach a human, never be auto-cleared. Each anchor is
 * itself hash-chained + audited via reanchorChain (idempotent), so the act of
 * reconciling is permanently recorded.
 */
export async function reconcileChain(by: AuditActor): Promise<ReconcileResult> {
  const analysis = await analyzeChain();
  if (analysis.tamperSeqs.length > 0) {
    return {
      reconciled: 0,
      forkSeqs: analysis.forkSeqs,
      newlyReconciledSeqs: [],
      tamperSeqs: analysis.tamperSeqs,
      refused: true,
      checkedCount: analysis.checkedCount,
    };
  }
  const newlyReconciledSeqs: number[] = [];
  for (const seq of analysis.forkSeqs) {
    const r = await reanchorChain(
      seq,
      "concurrency_fork (auto-reconciled: row hash self-valid, pre-advisory-lock legacy race)",
      by,
    );
    if (!r.alreadyAnchored) newlyReconciledSeqs.push(seq);
  }
  return {
    reconciled: newlyReconciledSeqs.length,
    forkSeqs: analysis.forkSeqs,
    newlyReconciledSeqs,
    tamperSeqs: [],
    refused: false,
    checkedCount: analysis.checkedCount,
  };
}

// ---------------------------------------------------------------------------
// queryAuditLog
// ---------------------------------------------------------------------------

function decodeCursor(cursor: string): number | null {
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf8");
    const n = Number(decoded);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function encodeCursor(seq: number): string {
  return Buffer.from(String(seq), "utf8").toString("base64");
}

export async function queryAuditLog(filter: QueryFilter): Promise<QueryResultPage> {
  const limit = Math.min(Math.max(1, filter.limit ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);

  const where: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (filter.actorUserId) {
    where.push(`actor_user_id = $${i++}`);
    params.push(filter.actorUserId);
  }
  if (filter.resourceType) {
    where.push(`resource_type = $${i++}`);
    params.push(filter.resourceType);
  }
  if (filter.resourceId) {
    where.push(`resource_id = $${i++}`);
    params.push(filter.resourceId);
  }
  if (filter.action) {
    where.push(`action = $${i++}`);
    params.push(filter.action);
  }
  if (filter.since) {
    where.push(`ts >= $${i++}`);
    params.push(filter.since.toISOString());
  }
  if (filter.until) {
    where.push(`ts <= $${i++}`);
    params.push(filter.until.toISOString());
  }
  if (filter.cursor) {
    const seqCursor = decodeCursor(filter.cursor);
    if (seqCursor !== null) {
      where.push(`seq < $${i++}`);
      params.push(seqCursor);
    }
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit + 1); // fetch one extra to know if more exist
  const limitParam = `$${i++}`;

  const { rows } = await safeQuery<{
    id: string;
    seq: string;
    ts: string;
    actor_user_id: string;
    actor_role: string;
    action: string;
    resource_type: string;
    resource_id: string | null;
    before_state: unknown;
    after_state: unknown;
    ip_address: string | null;
    user_agent: string | null;
    request_id: string | null;
    prev_hash: string | null;
    entry_hash: string;
  }>(
    `SELECT id, seq, ts, actor_user_id, actor_role, action, resource_type, resource_id,
            before_state, after_state, ip_address, user_agent, request_id,
            prev_hash, entry_hash
     FROM instinct_audit_log
     ${whereClause}
     ORDER BY seq DESC
     LIMIT ${limitParam}`,
    params,
  );

  let nextCursor: string | undefined;
  if (rows.length > limit) {
    const extra = rows.pop();
    if (extra) nextCursor = encodeCursor(Number(extra.seq));
  }

  const entries: AuditEntry[] = rows.map((r) => ({
    id: r.id,
    seq: Number(r.seq),
    ts: typeof r.ts === "string" ? r.ts : new Date(r.ts).toISOString(),
    actor: { user_id: r.actor_user_id, role: r.actor_role },
    action: r.action,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    beforeState: r.before_state,
    afterState: r.after_state,
    ipAddress: r.ip_address,
    userAgent: r.user_agent,
    requestId: r.request_id,
    prevHash: r.prev_hash,
    entryHash: r.entry_hash,
  }));

  return { entries, nextCursor };
}

// ---------------------------------------------------------------------------
// Helpers — extract actor + request metadata from a NextRequest
// ---------------------------------------------------------------------------

export function extractRequestMetadata(req: {
  headers: { get(name: string): string | null };
}): { ipAddress?: string; userAgent?: string; requestId?: string } {
  const ipRaw =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    undefined;
  // INET column rejects "unknown"; only include if it parses like an IP.
  const ipAddress = ipRaw && /^[0-9a-fA-F.:]+$/.test(ipRaw) ? ipRaw : undefined;
  const userAgent = req.headers.get("user-agent") || undefined;
  const requestId =
    req.headers.get("x-request-id") ||
    req.headers.get("x-vercel-id") ||
    undefined;
  return { ipAddress, userAgent, requestId };
}
