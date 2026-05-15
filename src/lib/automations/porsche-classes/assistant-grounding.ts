/**
 * Porsche-classes — assistant grounding source.
 *
 * Turns rows from `instinct_automation_porsche_snapshots` + `_deltas`
 * into `MeetingNoteHit`-shaped grounding the LLM can cite. Wired into
 * `getRelevantContext` alongside Plaud transcripts so a question like
 * "what classes ran last Friday?" or "what changed in BA101 this week?"
 * gets real, deterministic, zero-token grounding — no separate tool
 * call required.
 *
 * Why this is in the automation module, not assistant/context-resolver:
 *   - The automation module owns its schema; the resolver shouldn't
 *     have to know the table names.
 *   - When a second automation lands, it adds a sibling grounding
 *     module here — context-resolver just wires it in the same way.
 *
 * Contract guarantees:
 *   - Never throws — returns a typed result so the resolver can keep
 *     building the rest of the bundle when this surface errors.
 *   - Quiet on shadow mode (no DATABASE_URL) — returns ok with empty
 *     hits so chat() still works without the DB.
 *   - Date filter is applied at the SQL layer when supplied so we
 *     don't drag a year's worth of snapshots into memory.
 */

import { safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import type {
  MeetingNoteHit,
  MeetingNoteErrorResult,
} from "@/lib/assistant/context-resolver";

const SNAPSHOT_TOP_N_DEFAULT = 5;
const SNIPPET_MAX = 300;

/** Question keywords that turn the porsche-class lane on. We don't pay
 *  the SQL cost when the question is unambiguously not about classes. */
/* Keyword set:
   - Course slugs (ba101 / ba102) — most precise.
   - "porsche" or "porsche class" — vendor name.
   - "classes" (plural) — strong class signal in this product context.
   - "class" + temporal/prep ("class on", "class today", "class last").
   - Class-ops nouns — attendance / participants / instructor / registration. */
const PORSCHE_TRIGGER_RE =
  /\b(ba101|ba102|porsche|classes\b|class\s+(?:on|in|for|at|ran|today|yesterday|last|this|next|tomorrow)|attend(?:ee|ance)|participant|enrolled?|instructor|registration)\b/i;

export interface SearchPorscheClassNotesOptions {
  question: string;
  /** Optional ISO date range. When set, only snapshots whose class_date
   *  falls inside [startISO, endISO] are returned. */
  dateRange?: { startISO: string; endISO: string };
  topN?: number;
}

export interface SearchPorscheClassNotesOk {
  ok: true;
  hits: MeetingNoteHit[];
  took_ms: number;
}

export type SearchPorscheClassNotesResult =
  | SearchPorscheClassNotesOk
  | MeetingNoteErrorResult;

/** Returns true when the question is plausibly about porsche-classes
 *  state. Exposed for tests + the context-resolver's pre-filter. */
export function questionTouchesPorscheClasses(question: string): boolean {
  return PORSCHE_TRIGGER_RE.test(question);
}

interface SnapshotRow {
  id: string;
  course_type: string;
  class_date: string;
  location: string;
  participants: unknown;
  captured_at: string;
  class_key: string;
  added: unknown;
  dropped: unknown;
  net_change: number | null;
  delta_at: string | null;
}

function parseStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}

function clampSnippet(s: string): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length <= SNIPPET_MAX
    ? oneLine
    : oneLine.slice(0, SNIPPET_MAX - 1).trim() + "…";
}

function rowToSnippet(row: SnapshotRow): string {
  const participants = parseStringArray(row.participants);
  const added = parseStringArray(row.added);
  const dropped = parseStringArray(row.dropped);

  const head = `${participants.length} participant${participants.length === 1 ? "" : "s"}`;
  const sample = participants.slice(0, 5).join(", ");
  const sampleLine = sample ? `: ${sample}${participants.length > 5 ? ", …" : ""}` : "";

  const changes: string[] = [];
  if (added.length > 0) changes.push(`+${added.length} added (${added.slice(0, 3).join(", ")}${added.length > 3 ? ", …" : ""})`);
  if (dropped.length > 0) changes.push(`-${dropped.length} dropped (${dropped.slice(0, 3).join(", ")}${dropped.length > 3 ? ", …" : ""})`);
  const changeLine = changes.length > 0 ? ` · ${changes.join(", ")}` : "";

  return clampSnippet(`${head}${sampleLine}${changeLine}`);
}

/**
 * Look up porsche-class snapshots relevant to the question, optionally
 * filtered to a date range. Each hit carries the participant count,
 * a short sample of names, and the latest delta against the prior
 * snapshot (so "what changed" questions get the +added/-dropped lists
 * directly in the prompt block).
 */
export async function searchPorscheClassNotes(
  opts: SearchPorscheClassNotesOptions,
): Promise<SearchPorscheClassNotesResult> {
  const t0 = Date.now();
  const question = String(opts?.question ?? "").trim();
  if (!question) {
    return { ok: false, status: 400, code: "no_query", message: "empty_question" };
  }

  /* Trigger gate — porsche grounding only fires on plausibly-related
     questions. Skipping outright is cheaper than running an ILIKE that
     would return no hits anyway, and it keeps the analytics counter
     clean (we only emit lookup events when we actually queried). */
  if (!questionTouchesPorscheClasses(question)) {
    return { ok: true, hits: [], took_ms: Date.now() - t0 };
  }

  if (!process.env.DATABASE_URL) {
    return { ok: true, hits: [], took_ms: Date.now() - t0 };
  }

  const topN = opts.topN && opts.topN > 0 ? Math.min(opts.topN, 20) : SNAPSHOT_TOP_N_DEFAULT;

  /* Build a parameterized query that:
     - filters by class_date inside [startISO, endISO] when supplied,
     - LEFT JOINs the most recent delta per class_key so "what changed"
       questions get the diff inline,
     - orders newest snapshots first so the assistant sees current
       state, not historical baselines. */
  const params: (string | number)[] = [];
  const where: string[] = [];

  if (opts.dateRange) {
    params.push(opts.dateRange.startISO.slice(0, 10));
    params.push(opts.dateRange.endISO.slice(0, 10));
    where.push(`s.class_date BETWEEN $${params.length - 1}::date AND $${params.length}::date`);
  }

  /* Term filter on course/location keeps results relevant when the
     question names BA101 / BA102 / a city. Skipped when no terms match
     so we don't accidentally narrow to zero rows. */
  const lowered = question.toLowerCase();
  const termClauses: string[] = [];
  for (const candidate of ["ba101", "ba102"]) {
    if (lowered.includes(candidate)) {
      params.push(candidate.toUpperCase());
      termClauses.push(`s.course_type = $${params.length}`);
    }
  }
  if (termClauses.length > 0) {
    where.push(`(${termClauses.join(" OR ")})`);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  params.push(topN);
  const limitParam = `$${params.length}`;

  let rows: SnapshotRow[] = [];
  try {
    const r = await safeQuery<SnapshotRow>(
      `WITH latest_snapshots AS (
         SELECT DISTINCT ON (s.class_key)
           s.id, s.course_type, s.class_date, s.location, s.participants,
           s.captured_at, s.class_key
         FROM instinct_automation_porsche_snapshots s
         ${whereSql}
         ORDER BY s.class_key, s.captured_at DESC
       ),
       latest_deltas AS (
         SELECT DISTINCT ON (d.class_key)
           d.class_key, d.added, d.dropped, d.net_change,
           d.created_at AS delta_at
         FROM instinct_automation_porsche_deltas d
         ORDER BY d.class_key, d.created_at DESC
       )
       SELECT ls.id, ls.course_type, ls.class_date::text AS class_date,
              ls.location, ls.participants, ls.captured_at::text AS captured_at,
              ls.class_key,
              COALESCE(ld.added, '[]'::jsonb) AS added,
              COALESCE(ld.dropped, '[]'::jsonb) AS dropped,
              ld.net_change,
              ld.delta_at::text AS delta_at
         FROM latest_snapshots ls
         LEFT JOIN latest_deltas ld ON ld.class_key = ls.class_key
         ORDER BY ls.class_date DESC
         LIMIT ${limitParam}`,
      params,
    );
    if (r.fromCache) {
      /* Shadow mode at the safeQuery layer — same as no DATABASE_URL. */
      return { ok: true, hits: [], took_ms: Date.now() - t0 };
    }
    rows = r.rows;
  } catch (err) {
    return {
      ok: false,
      status: 500,
      code: "internal",
      message: (err as Error)?.message || "porsche_class_lookup_failed",
    };
  }

  const hits: MeetingNoteHit[] = rows.map((row) => ({
    id: row.id,
    title: `${row.course_type} ${row.class_date} ${row.location}`,
    occurred_at: row.captured_at,
    snippet: rowToSnippet(row),
    source_kind: "porsche_class",
    url: `/automations/porsche-classes`,
  }));

  return { ok: true, hits, took_ms: Date.now() - t0 };
}

/** Track a porsche-class grounding failure as a typed analytics event.
 *  Mirrors trackMeetingLookupFailure so the resolver can call them
 *  uniformly without special-casing per source. */
export function trackPorscheClassLookupFailure(
  userId: string,
  role: string,
  error: MeetingNoteErrorResult,
): void {
  trackEvent("assistant.porsche_class_lookup_failed", userId, role, {
    status: error.status,
    code: error.code,
    scope_missing: Boolean(error.scope_missing),
  });
}
