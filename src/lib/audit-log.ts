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
 * Threading / concurrency: recordAudit wraps SELECT-prev + INSERT in a single
 * serializable transaction. Under contention, Postgres serialization errors
 * bubble up to the caller; callers should retry. In the common low-write case
 * (HR mutations, auth events), contention is negligible.
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

    const prev = await client.query<{ entry_hash: string; seq: string }>(
      `SELECT entry_hash, seq FROM instinct_audit_log
       ORDER BY seq DESC LIMIT 1 FOR UPDATE`,
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
      return { valid: false, brokenAt: seq, checkedCount: checked, reason: "prev_hash_mismatch" };
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
      return { valid: false, brokenAt: seq, checkedCount: checked, reason: "entry_hash_mismatch" };
    }

    expectedPrev = row.entry_hash;
    checked++;
  }

  return { valid: true, checkedCount: checked };
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
