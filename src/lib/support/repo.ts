/**
 * support / repo — Postgres CRUD for support tickets + patterns,
 * plus triple-write hooks (Qdrant + Neo4j).
 *
 * Conventions:
 *   - Every write goes through `writeQuery` with `expectRows: 1` so a
 *     silently-discarded INSERT/UPDATE surfaces as a thrown error
 *     rather than a 200 with no row (per memory feedback_no_silent_data_loss).
 *   - Triple-write side-effects (Qdrant + Neo4j) are best-effort. They
 *     log + swallow on failure so a Vector/Graph outage cannot block a
 *     ticket from being filed (per global CLAUDE.md graceful-degradation).
 *   - Returned objects are typed (SupportTicket / SupportPattern), not
 *     raw rows.
 *
 * The named exports here are the contract the API routes assume. Keep
 * the signatures stable.
 */

import { query, writeQuery } from "@/lib/db";
import { upsertKnowledgePoint } from "@/lib/qdrant";
import { executeCypher } from "@/lib/neo4j";

import type {
  SupportAudience,
  SupportPattern,
  SupportSeverity,
  SupportStatus,
  SupportTicket,
} from "./types";
import type { SeedPattern } from "./seed-patterns";

// ---------------------------------------------------------------------------
// Public types matching the API-route contract
// ---------------------------------------------------------------------------

export interface CreateTicketRow {
  title: string;
  body: string;
  diagnostic_text?: string | null;
  category?: string | null;
  severity?: SupportSeverity | string | null;
  status?: SupportStatus | string;
  audience?: SupportAudience | string | null;
  created_by_user_id: string;
  created_by_email?: string | null;
}

export interface ListTicketsOptions {
  status?: string;
  category?: string;
  audience?: string;
  limit?: number;
}

export interface RecordFeedbackPayload {
  helpful: boolean;
  edit_diff?: Record<string, unknown> | null;
  notes?: string | null;
  reviewed_by_user_id?: string | null;
}

// ---------------------------------------------------------------------------
// Row → typed object normalizers
// ---------------------------------------------------------------------------

function rowToTicket(r: Record<string, unknown>): SupportTicket {
  /* `audience` is NOT NULL in the schema with default 'internal', but
     defensive normalization keeps any old in-memory rows or test
     fixtures from blowing up when the column is absent. */
  const audienceRaw = r.audience == null ? "internal" : String(r.audience);
  const audience: SupportAudience =
    audienceRaw === "client" ? "client" : "internal";
  return {
    id: String(r.id),
    title: String(r.title),
    body: String(r.body),
    diagnostic_text: r.diagnostic_text == null ? null : String(r.diagnostic_text),
    category: String(r.category ?? "general"),
    severity: r.severity as SupportTicket["severity"],
    status: r.status as SupportTicket["status"],
    audience,
    created_by_user_id: String(r.created_by_user_id),
    created_by_email: r.created_by_email == null ? null : String(r.created_by_email),
    draft_response: r.draft_response == null ? null : String(r.draft_response),
    draft_generated_at: r.draft_generated_at == null ? null : String(r.draft_generated_at),
    draft_pattern_ids: Array.isArray(r.draft_pattern_ids)
      ? (r.draft_pattern_ids as unknown[]).map((x) => String(x))
      : [],
    sent_response: r.sent_response == null ? null : String(r.sent_response),
    sent_at: r.sent_at == null ? null : String(r.sent_at),
    sent_to_email: r.sent_to_email == null ? null : String(r.sent_to_email),
    helpful: r.helpful == null ? null : Boolean(r.helpful),
    edit_diff: (r.edit_diff as Record<string, unknown> | null) ?? null,
    feedback_notes: r.feedback_notes == null ? null : String(r.feedback_notes),
    feedback_at: r.feedback_at == null ? null : String(r.feedback_at),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

function rowToPattern(r: Record<string, unknown>): SupportPattern {
  return {
    id: String(r.id),
    slug: String(r.slug),
    name: String(r.name),
    category: String(r.category),
    match_signatures: Array.isArray(r.match_signatures)
      ? (r.match_signatures as SupportPattern["match_signatures"])
      : [],
    draft_template: String(r.draft_template),
    success_count: Number(r.success_count ?? 0),
    fail_count: Number(r.fail_count ?? 0),
    enabled: Boolean(r.enabled),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

const TICKET_COLUMNS = `
  id, title, body, diagnostic_text, category, severity, status, audience,
  created_by_user_id, created_by_email,
  draft_response, draft_generated_at::text AS draft_generated_at, draft_pattern_ids,
  sent_response, sent_at::text AS sent_at, sent_to_email,
  helpful, edit_diff, feedback_notes, feedback_at::text AS feedback_at,
  created_at::text AS created_at, updated_at::text AS updated_at
`;

const PATTERN_COLUMNS = `
  id, slug, name, category, match_signatures, draft_template,
  success_count, fail_count, enabled,
  created_at::text AS created_at, updated_at::text AS updated_at
`;

// ---------------------------------------------------------------------------
// Triple-write side-effects (best-effort, never throw)
// ---------------------------------------------------------------------------

async function tryQdrantTicketUpsert(t: SupportTicket): Promise<void> {
  try {
    const question = [t.title, t.body, t.diagnostic_text ?? ""].join("\n").trim();
    await upsertKnowledgePoint(
      `support-ticket:${t.id}`,
      question,
      t.draft_response ?? "",
      "support",
      ["support-ticket", t.category, t.severity],
    );
  } catch (err) {
    console.warn("[support/repo] Qdrant upsert failed:", (err as Error).message);
  }
}

async function tryNeo4jCreate(t: SupportTicket): Promise<void> {
  try {
    await executeCypher(
      `MERGE (o:Operator {user_id: $user_id})
       MERGE (s:SupportTicket {id: $id})
       ON CREATE SET s.category = $category,
                     s.severity = $severity,
                     s.created_at = datetime($created_at)
       MERGE (o)-[:CREATED]->(s)`,
      {
        user_id: t.created_by_user_id,
        id: t.id,
        category: t.category,
        severity: t.severity,
        created_at: t.created_at,
      },
    );
  } catch (err) {
    console.warn("[support/repo] Neo4j CREATED edge failed:", (err as Error).message);
  }
}

async function tryNeo4jMatched(ticketId: string, patternId: string): Promise<void> {
  try {
    await executeCypher(
      `MERGE (s:SupportTicket {id: $ticketId})
       MERGE (p:SupportPattern {id: $patternId})
       MERGE (s)-[:MATCHED]->(p)`,
      { ticketId, patternId },
    );
  } catch (err) {
    console.warn("[support/repo] Neo4j MATCHED edge failed:", (err as Error).message);
  }
}

async function tryNeo4jRated(
  ticketId: string,
  patternId: string,
  helpful: boolean,
): Promise<void> {
  try {
    await executeCypher(
      `MERGE (s:SupportTicket {id: $ticketId})
       MERGE (p:SupportPattern {id: $patternId})
       MERGE (s)-[r:RATED]->(p)
       ON CREATE SET r.helpful = $helpful, r.at = datetime()
       ON MATCH  SET r.helpful = $helpful, r.at = datetime()`,
      { ticketId, patternId, helpful },
    );
  } catch (err) {
    console.warn("[support/repo] Neo4j RATED edge failed:", (err as Error).message);
  }
}

async function tryNeo4jSent(ticketId: string, sentAt: string): Promise<void> {
  try {
    await executeCypher(
      `MERGE (s:SupportTicket {id: $ticketId})
       SET s.sent_at = datetime($sentAt)`,
      { ticketId, sentAt },
    );
  } catch (err) {
    console.warn("[support/repo] Neo4j sent_at update failed:", (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Ticket CRUD
// ---------------------------------------------------------------------------

export async function createTicket(input: CreateTicketRow): Promise<SupportTicket> {
  /* Normalize audience defensively. Anything that isn't an exact
     'client' or 'internal' falls back to 'internal' — the column has a
     CHECK constraint, so passing through arbitrary strings would error
     at the DB layer; better to coerce here and let the caller's own
     400 validation handle bad input upstream. */
  const audienceNormalized: SupportAudience =
    input.audience === "client" ? "client" : "internal";
  const r = await writeQuery(
    `INSERT INTO instinct_support_tickets
       (title, body, diagnostic_text, category, severity, status, audience,
        created_by_user_id, created_by_email)
     VALUES ($1, $2, $3,
             COALESCE($4, 'general'),
             COALESCE($5, 'p2'),
             COALESCE($6, 'open'),
             $7,
             $8, $9)
     RETURNING ${TICKET_COLUMNS}`,
    [
      input.title,
      input.body,
      input.diagnostic_text ?? null,
      input.category ?? null,
      input.severity ?? null,
      input.status ?? null,
      audienceNormalized,
      input.created_by_user_id,
      input.created_by_email ?? null,
    ],
    { expectRows: 1 },
  );
  const ticket = rowToTicket(r.rows[0] as Record<string, unknown>);
  await tryQdrantTicketUpsert(ticket);
  await tryNeo4jCreate(ticket);
  return ticket;
}

export async function getTicket(id: string): Promise<SupportTicket | null> {
  const r = await query<Record<string, unknown>>(
    `SELECT ${TICKET_COLUMNS}
       FROM instinct_support_tickets
      WHERE id = $1
      LIMIT 1`,
    [id],
  );
  return r.rows[0] ? rowToTicket(r.rows[0]) : null;
}

export async function listTickets(opts: ListTicketsOptions = {}): Promise<SupportTicket[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.status && opts.status !== "all") {
    params.push(opts.status);
    where.push(`status = $${params.length}`);
  }
  if (opts.category) {
    params.push(opts.category);
    where.push(`category = $${params.length}`);
  }
  /* `audience='all'` is treated as no filter so the UI can use the same
     pill pattern as the status filter without special-casing. */
  if (opts.audience && opts.audience !== "all") {
    params.push(opts.audience);
    where.push(`audience = $${params.length}`);
  }
  const limit = clampLimit(opts.limit);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const r = await query<Record<string, unknown>>(
    `SELECT ${TICKET_COLUMNS}
       FROM instinct_support_tickets
       ${whereSql}
      ORDER BY created_at DESC
      LIMIT ${limit}`,
    params,
  );
  return r.rows.map(rowToTicket);
}

const PATCHABLE_FIELDS = new Set<string>([
  "title",
  "body",
  "diagnostic_text",
  "category",
  "severity",
  "status",
  "audience",
  "draft_response",
  "draft_generated_at",
  "draft_pattern_ids",
  "sent_response",
  "sent_at",
  "sent_to_email",
]);

const ARRAY_UUID_FIELDS = new Set<string>(["draft_pattern_ids"]);

/**
 * Partial update of an editable ticket field set. Returns the updated
 * ticket, or null when the row was not found. No-op patches return the
 * existing row without issuing an UPDATE.
 *
 * Triple-write hooks fire when the patch includes the relevant column:
 *   - draft_pattern_ids → Neo4j (SupportTicket)-[:MATCHED]->(SupportPattern)
 *   - sent_at           → Neo4j SupportTicket.sent_at update
 */
export async function updateTicket(
  id: string,
  patch: Partial<SupportTicket> & Record<string, unknown>,
): Promise<SupportTicket | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!PATCHABLE_FIELDS.has(k)) continue;
    if (ARRAY_UUID_FIELDS.has(k)) {
      params.push(v ?? []);
      sets.push(`${k} = $${params.length}::uuid[]`);
    } else {
      params.push(v ?? null);
      sets.push(`${k} = $${params.length}`);
    }
  }
  if (sets.length === 0) {
    return getTicket(id);
  }
  sets.push(`updated_at = NOW()`);
  params.push(id);
  const r = await writeQuery(
    `UPDATE instinct_support_tickets
        SET ${sets.join(", ")}
      WHERE id = $${params.length}
      RETURNING ${TICKET_COLUMNS}`,
    params,
  );
  if (r.rows.length === 0) return null;
  const ticket = rowToTicket(r.rows[0] as Record<string, unknown>);

  if (Array.isArray(patch.draft_pattern_ids) && patch.draft_pattern_ids.length > 0) {
    for (const pid of patch.draft_pattern_ids) {
      await tryNeo4jMatched(ticket.id, String(pid));
    }
  }
  if (typeof patch.sent_at === "string" && patch.sent_at.length > 0) {
    await tryNeo4jSent(ticket.id, patch.sent_at);
  }
  return ticket;
}

export async function deleteTicket(id: string): Promise<boolean> {
  const r = await writeQuery(
    `DELETE FROM instinct_support_tickets
      WHERE id = $1
      RETURNING id`,
    [id],
  );
  return r.rows.length > 0;
}

/**
 * Capture post-send feedback and propagate to every pattern that informed
 * the draft. Each draft_pattern_id gets +1 to success_count when helpful,
 * +1 to fail_count otherwise. We MERGE a (:RATED) edge per pattern so the
 * graph layer can answer "which pattern hurts most".
 *
 * Returns null when the ticket id is unknown (so the route can 404).
 */
export async function recordFeedback(
  id: string,
  payload: RecordFeedbackPayload,
): Promise<SupportTicket | null> {
  const r = await writeQuery(
    `UPDATE instinct_support_tickets
        SET helpful = $2,
            edit_diff = $3::jsonb,
            feedback_notes = $4,
            feedback_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
      RETURNING ${TICKET_COLUMNS}`,
    [
      id,
      payload.helpful,
      payload.edit_diff ? JSON.stringify(payload.edit_diff) : null,
      payload.notes ?? null,
    ],
  );
  if (r.rows.length === 0) return null;
  const ticket = rowToTicket(r.rows[0] as Record<string, unknown>);

  const counterColumn = payload.helpful ? "success_count" : "fail_count";
  for (const patternId of ticket.draft_pattern_ids) {
    try {
      await writeQuery(
        `UPDATE instinct_support_patterns
            SET ${counterColumn} = ${counterColumn} + 1,
                updated_at = NOW()
          WHERE id = $1
          RETURNING id`,
        [patternId],
        { expectRows: 1 },
      );
    } catch (err) {
      console.warn(
        "[support/repo] feedback counter update failed:",
        (err as Error).message,
      );
    }
    await tryNeo4jRated(ticket.id, patternId, payload.helpful);
  }
  return ticket;
}

// ---------------------------------------------------------------------------
// Pattern CRUD
// ---------------------------------------------------------------------------

export async function listEnabledPatterns(): Promise<SupportPattern[]> {
  const r = await query<Record<string, unknown>>(
    `SELECT ${PATTERN_COLUMNS}
       FROM instinct_support_patterns
      WHERE enabled = TRUE
      ORDER BY (success_count - fail_count) DESC, slug ASC`,
  );
  return r.rows.map(rowToPattern);
}

export async function getPatternBySlug(slug: string): Promise<SupportPattern | null> {
  const r = await query<Record<string, unknown>>(
    `SELECT ${PATTERN_COLUMNS}
       FROM instinct_support_patterns
      WHERE slug = $1
      LIMIT 1`,
    [slug],
  );
  return r.rows[0] ? rowToPattern(r.rows[0]) : null;
}

/**
 * Idempotent upsert for a single seed pattern. Used by tests + ad-hoc
 * seeders. Returns the persisted row. Never resets success/fail counts.
 */
export async function upsertSeedPattern(seed: SeedPattern): Promise<SupportPattern> {
  const r = await writeQuery(
    `INSERT INTO instinct_support_patterns
       (slug, name, category, match_signatures, draft_template)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (slug) DO UPDATE
       SET name = EXCLUDED.name,
           category = EXCLUDED.category,
           match_signatures = EXCLUDED.match_signatures,
           draft_template = EXCLUDED.draft_template,
           updated_at = NOW()
     RETURNING ${PATTERN_COLUMNS}`,
    [
      seed.slug,
      seed.name,
      seed.category,
      JSON.stringify(seed.match_signatures),
      seed.draft_template,
    ],
    { expectRows: 1 },
  );
  return rowToPattern(r.rows[0] as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function clampLimit(raw: number | undefined): number {
  const n = Math.floor(raw ?? 100);
  if (!Number.isFinite(n) || n < 1) return 100;
  return Math.min(n, 500);
}
