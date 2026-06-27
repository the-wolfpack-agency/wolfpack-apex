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
  /* ISO-8601, or null when the row carried no usable timestamp (an
     errored / pending analysis persisted before it was analyzed).
     Callers must treat null as "unknown time", never feed it to
     `new Date(...)` blindly. */
  analyzed_at: string | null;
  /* Convenience one-line summary the assembler uses in the brief
     panel. The Phase 2 LLM prompt doesn't currently produce it, so
     we synthesize from the first decision (or topic) at read time —
     `null` when neither is present. Keeps this shape compatible
     with the Phase 4/5 callers that import MeetingAnalysisRecord
     from types.ts. */
  summary: string | null;
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
  created_at: string | null;
}

interface AnalysisRow extends Record<string, unknown> {
  id: string;
  message_id: string;
  analyzer_version: string;
  // May be null in practice: an errored / pending analysis is persisted
  // before it is analyzed. Typed nullable so call sites must guard.
  analyzed_at: string | null;
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
  created_at: string | null;
}

/* ------------------------------------------------------------------ */
/* Mappers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Coerce a DB timestamp value to an ISO-8601 string, tolerating null /
 * undefined / invalid input WITHOUT throwing.
 *
 * Production reality: a row can carry a null `analyzed_at` (an analysis
 * that errored or is still pending was persisted before it was ever
 * analyzed) or a non-string value the driver hands back. The previous
 * code did `new Date(row.analyzed_at).toISOString()` unconditionally,
 * which throws `RangeError: Invalid time value` for null/garbage and
 * 500'd the whole read path. We fall back to the supplied `fallback`
 * timestamp (the sibling column) and finally to null.
 */
function toIsoOrNull(
  value: unknown,
  fallback: string | null = null,
): string | null {
  if (typeof value === "string" && value.length > 0) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return value;
  } else if (value instanceof Date) {
    if (!Number.isNaN(value.getTime())) return value.toISOString();
  } else if (typeof value === "number" && Number.isFinite(value)) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  // Invalid / missing - use the fallback if it is itself valid.
  if (typeof fallback === "string" && fallback.length > 0) {
    const d = new Date(fallback);
    if (!Number.isNaN(d.getTime())) return fallback;
  }
  return null;
}

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

  const decisions = parseJson<MeetingAnalysis["decisions"]>(row.decisions, []);
  const topics = row.topics ?? [];
  /* Summary precedence for the Phase 4 brief panel:
       1. An explicit `summary` value stored on the row (the analyzer
          may persist one; the Phase 4/5 read path treats it as
          authoritative). The type-unification refactor (82c4cc3e)
          accidentally dropped this preference and always synthesized
          from decisions - that regressed the stored-summary path.
       2. Else synthesize from the first decision (analyzer puts the
          text in `summary`; the simulated row uses `description` -
          accept either).
       3. Else a comma-joined preview of the top topics.
       4. Else null. */
  const storedSummary =
    typeof row.summary === "string" ? row.summary.trim() : "";
  const firstDec = decisions[0] as
    | { summary?: string; description?: string }
    | undefined;
  const firstDecText = (firstDec?.summary || firstDec?.description || "").trim();
  const summary =
    storedSummary ||
    firstDecText ||
    (topics.length > 0 ? topics.slice(0, 3).join(" · ") : null);

  return {
    id: row.id,
    message_id: row.message_id,
    analyzer_version: row.analyzer_version,
    // Tolerate null / invalid timestamps (errored or pending analyses
    // persisted before analysis ran). Prefer analyzed_at; fall back to
    // created_at; null when neither is a usable date - never throw.
    analyzed_at: toIsoOrNull(
      row.analyzed_at,
      typeof row.created_at === "string" ? row.created_at : null,
    ),
    summary,
    decisions,
    action_items: parseJson<MeetingAnalysis["action_items"]>(
      row.action_items,
      [],
    ),
    topics,
    attendees: parseJson<MeetingAnalysis["attendees"]>(row.attendees, []),
    blockers: parseJson<MeetingAnalysis["blockers"]>(row.blockers, []),
    next_steps: parseJson<MeetingAnalysis["next_steps"]>(row.next_steps, []),
    raw_llm_response: row.raw_llm_response,
    model: row.model,
    tokens_used: row.tokens_used,
    status: row.status,
    error_detail: row.error_detail,
    created_at: toIsoOrNull(
      row.created_at,
      typeof row.analyzed_at === "string" ? row.analyzed_at : null,
    ),
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
 * Returns the SIMPLER `TypesMeetingAnalysisRecord` shape from
 * `./types.ts` — which is what Phase 4/5 callers (brief.ts,
 * aggregator.ts) import. The repo's richer internal record carries
 * operational fields (analyzer_version, raw_llm_response, etc.) that
 * Phase 4/5 doesn't need; we project down to the public shape here.
 *
 * Tolerant of the analyses table not yet existing (early-bootstrap
 * worktree before migration 084 ran) — Postgres 42P01 surfaces as an
 * empty Map, never an exception.
 */
import type {
  MeetingAnalysisRecord as TypesMeetingAnalysisRecord,
  Decision as TypesDecision,
  ActionItem as TypesActionItem,
  Topic as TypesTopic,
  Attendee as TypesAttendee,
} from "./types";

function toPublicShape(r: MeetingAnalysisRecord): TypesMeetingAnalysisRecord {
  /* Map the richer analyzer output (analyzer/types.ts shapes) down to
     the simpler PUBLIC types.ts shape Phase 4/5 callers consume.
     Field-name mismatches handled here once so the rest of the
     surface stays clean. */
  const pick = <T,>(obj: unknown, keys: string[]): T | null => {
    if (typeof obj !== "object" || obj === null) return null;
    for (const k of keys) {
      const v = (obj as Record<string, unknown>)[k];
      if (v != null) return v as T;
    }
    return null;
  };
  const decisions: TypesDecision[] = (r.decisions ?? []).map((d) => ({
    description:
      typeof d === "string"
        ? d
        : (pick<string>(d, ["description", "summary"]) ?? ""),
    decided_by: pick<string>(d, ["decided_by", "made_by", "owners"]),
    source_message_id: r.message_id,
  }));
  const action_items: TypesActionItem[] = (r.action_items ?? []).map((a) => ({
    description:
      typeof a === "string"
        ? a
        : (pick<string>(a, ["description"]) ?? ""),
    assignee: pick<string>(a, ["assignee", "owner"]),
    due: pick<string>(a, ["due", "due_date"]),
    source_message_id: r.message_id,
  }));
  const topics: TypesTopic[] = (r.topics ?? []).map((t) =>
    typeof t === "string"
      ? { topic: t, detail: null }
      : { topic: pick<string>(t, ["topic"]) ?? "", detail: null },
  );
  const attendees: TypesAttendee[] = (r.attendees ?? []).map((a) => ({
    email: pick<string>(a, ["email"]),
    name: pick<string>(a, ["name"]),
  }));
  const blockers: string[] = (r.blockers ?? []).map((b) =>
    typeof b === "string" ? b : (pick<string>(b, ["description"]) ?? ""),
  );
  const next_steps: string[] = (r.next_steps ?? []).map((n) =>
    typeof n === "string" ? n : (pick<string>(n, ["description"]) ?? String(n)),
  );
  return {
    id: r.id,
    message_id: r.message_id,
    summary: r.summary,
    decisions,
    action_items,
    topics,
    attendees,
    blockers,
    next_steps,
    created_at: r.created_at,
  };
}

export async function getAnalysesByMessageIds(
  message_ids: string[],
): Promise<Map<string, TypesMeetingAnalysisRecord>> {
  const out = new Map<string, TypesMeetingAnalysisRecord>();
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
      out.set(row.message_id, toPublicShape(rowToAnalysis(row)));
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
