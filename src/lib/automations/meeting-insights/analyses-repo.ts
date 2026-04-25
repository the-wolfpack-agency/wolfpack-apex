/**
 * meeting-insights / analyses-repo — DB layer for instinct_meeting_analyses.
 *
 * Pure CRUD. The analyzer module owns the LLM call; this module owns
 * persistence + idempotency.
 *
 * Idempotency contract:
 *   - upsertAnalysis is keyed on (message_id, analyzer_version). Same
 *     pair = no-op (we still touch updated_at via SET).
 *   - getLatestAnalysisForMessage returns the most recent row by
 *     analyzed_at; the API + UI only ever care about the latest version.
 */

import { query, writeQuery } from "@/lib/db";
import type {
  MeetingAnalysis,
  MeetingAnalysisStatus,
} from "./analyzer/types";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface MeetingAnalysisRecord {
  id: string;
  message_id: string;
  analyzer_version: string;
  analyzed_at: string;
  decisions: MeetingAnalysis["decisions"];
  action_items: MeetingAnalysis["action_items"];
  topics: string[];
  attendees: MeetingAnalysis["attendees"];
  blockers: MeetingAnalysis["blockers"];
  next_steps: MeetingAnalysis["next_steps"];
  raw_llm_response: string | null;
  model: string | null;
  tokens_used: number | null;
  status: MeetingAnalysisStatus;
  error_detail: string | null;
  created_at: string;
}

interface AnalysisRow extends Record<string, unknown> {
  id: string;
  message_id: string;
  analyzer_version: string;
  analyzed_at: string;
  decisions: unknown;
  action_items: unknown;
  topics: string[] | null;
  attendees: unknown;
  blockers: unknown;
  next_steps: unknown;
  raw_llm_response: string | null;
  model: string | null;
  tokens_used: number | null;
  status: MeetingAnalysisStatus;
  error_detail: string | null;
  created_at: string;
}

/* ------------------------------------------------------------------ */
/* Mappers                                                             */
/* ------------------------------------------------------------------ */

function rowToAnalysis(row: AnalysisRow): MeetingAnalysisRecord {
  // jsonb columns come back from `pg` as parsed objects; older drivers
  // sometimes return strings — defensively re-parse if so.
  const parseJson = <T>(v: unknown, fallback: T): T => {
    if (v == null) return fallback;
    if (typeof v === "string") {
      try {
        return JSON.parse(v) as T;
      } catch {
        return fallback;
      }
    }
    return v as T;
  };

  return {
    id: row.id,
    message_id: row.message_id,
    analyzer_version: row.analyzer_version,
    analyzed_at:
      typeof row.analyzed_at === "string"
        ? row.analyzed_at
        : new Date(row.analyzed_at).toISOString(),
    decisions: parseJson<MeetingAnalysis["decisions"]>(row.decisions, []),
    action_items: parseJson<MeetingAnalysis["action_items"]>(
      row.action_items,
      [],
    ),
    topics: row.topics ?? [],
    attendees: parseJson<MeetingAnalysis["attendees"]>(row.attendees, []),
    blockers: parseJson<MeetingAnalysis["blockers"]>(row.blockers, []),
    next_steps: parseJson<MeetingAnalysis["next_steps"]>(row.next_steps, []),
    raw_llm_response: row.raw_llm_response,
    model: row.model,
    tokens_used: row.tokens_used,
    status: row.status,
    error_detail: row.error_detail,
    created_at:
      typeof row.created_at === "string"
        ? row.created_at
        : new Date(row.created_at).toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export async function getLatestAnalysisForMessage(
  message_id: string,
): Promise<MeetingAnalysisRecord | null> {
  const r = await query<AnalysisRow>(
    `SELECT id, message_id, analyzer_version, analyzed_at,
            decisions, action_items, topics, attendees, blockers, next_steps,
            raw_llm_response, model, tokens_used, status, error_detail, created_at
       FROM instinct_meeting_analyses
      WHERE message_id = $1
      ORDER BY analyzed_at DESC
      LIMIT 1`,
    [message_id],
  );
  return r.rows.length === 0 ? null : rowToAnalysis(r.rows[0]);
}

export async function getAnalysisByVersion(args: {
  message_id: string;
  analyzer_version: string;
}): Promise<MeetingAnalysisRecord | null> {
  const r = await query<AnalysisRow>(
    `SELECT id, message_id, analyzer_version, analyzed_at,
            decisions, action_items, topics, attendees, blockers, next_steps,
            raw_llm_response, model, tokens_used, status, error_detail, created_at
       FROM instinct_meeting_analyses
      WHERE message_id = $1 AND analyzer_version = $2
      LIMIT 1`,
    [args.message_id, args.analyzer_version],
  );
  return r.rows.length === 0 ? null : rowToAnalysis(r.rows[0]);
}

/**
 * Bulk-fetch the LATEST analysis per message_id. Used by Phase 4 (brief)
 * and Phase 5 (ad-hoc analyze) to enrich a list of messages with their
 * analyses in a single round-trip. Returns a Map keyed on message_id;
 * messages with no analysis are simply absent from the map.
 *
 * Tolerant of the analyses table not yet existing (early-bootstrap
 * worktree before migration 084 ran) — Postgres 42P01 surfaces as an
 * empty Map, never an exception.
 */
export async function getAnalysesByMessageIds(
  message_ids: string[],
): Promise<Map<string, MeetingAnalysisRecord>> {
  const out = new Map<string, MeetingAnalysisRecord>();
  if (message_ids.length === 0) return out;
  try {
    const r = await query<AnalysisRow>(
      `SELECT DISTINCT ON (message_id)
              id, message_id, analyzer_version, analyzed_at,
              decisions, action_items, topics, attendees, blockers, next_steps,
              raw_llm_response, model, tokens_used, status, error_detail, created_at
         FROM instinct_meeting_analyses
        WHERE message_id = ANY($1::uuid[])
        ORDER BY message_id, analyzed_at DESC`,
      [message_ids],
    );
    for (const row of r.rows) {
      out.set(row.message_id, rowToAnalysis(row));
    }
  } catch (err) {
    /* 42P01 = relation does not exist (migration not yet applied).
       Brief + analyze degrade gracefully to "no analyses available" —
       counts/listings still render, decisions/actions just empty. */
    const code = (err as { code?: string }).code;
    if (code !== "42P01") throw err;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Upsert                                                              */
/* ------------------------------------------------------------------ */

export interface UpsertAnalysisInput {
  message_id: string;
  analyzer_version: string;
  analysis: MeetingAnalysis;
  raw_llm_response?: string;
  model?: string;
  tokens_used?: number;
  status: MeetingAnalysisStatus;
  error_detail?: string;
}

export async function upsertAnalysis(
  input: UpsertAnalysisInput,
): Promise<MeetingAnalysisRecord> {
  const r = await writeQuery<AnalysisRow>(
    `INSERT INTO instinct_meeting_analyses
        (message_id, analyzer_version, analyzed_at,
         decisions, action_items, topics, attendees, blockers, next_steps,
         raw_llm_response, model, tokens_used, status, error_detail)
     VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (message_id, analyzer_version) DO UPDATE SET
        analyzed_at      = EXCLUDED.analyzed_at,
        decisions        = EXCLUDED.decisions,
        action_items     = EXCLUDED.action_items,
        topics           = EXCLUDED.topics,
        attendees        = EXCLUDED.attendees,
        blockers         = EXCLUDED.blockers,
        next_steps       = EXCLUDED.next_steps,
        raw_llm_response = EXCLUDED.raw_llm_response,
        model            = EXCLUDED.model,
        tokens_used      = EXCLUDED.tokens_used,
        status           = EXCLUDED.status,
        error_detail     = EXCLUDED.error_detail
     RETURNING id, message_id, analyzer_version, analyzed_at,
               decisions, action_items, topics, attendees, blockers, next_steps,
               raw_llm_response, model, tokens_used, status, error_detail, created_at`,
    [
      input.message_id,
      input.analyzer_version,
      JSON.stringify(input.analysis.decisions),
      JSON.stringify(input.analysis.action_items),
      input.analysis.topics,
      JSON.stringify(input.analysis.attendees),
      JSON.stringify(input.analysis.blockers),
      JSON.stringify(input.analysis.next_steps),
      input.raw_llm_response ?? null,
      input.model ?? null,
      input.tokens_used ?? null,
      input.status,
      input.error_detail ?? null,
    ],
    { expectRows: 1 },
  );
  return rowToAnalysis(r.rows[0]);
}
