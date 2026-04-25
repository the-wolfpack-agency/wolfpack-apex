/**
 * Per-class summary assembler for the porsche-classes automation.
 *
 * Reads the latest snapshot per source_type for the given `class_key`
 * out of `instinct_automation_porsche_snapshots` (Stream A's table) and
 * stitches together the AssembledSummary the renderer expects.
 *
 * Pure-ish: takes an injectable `query` function (defaults to the
 * shared connection-pool helper from `@/lib/db`). That's what makes it
 * testable without spinning up Postgres — pass a fake.
 *
 * Returns null when no snapshots exist for the class (route turns this
 * into a 404). Callers MUST treat null as "not found", not "empty".
 *
 * Source-of-truth rules per the contract:
 *   - participants come from the latest porsche_xlsx snapshot.
 *   - coordinator notes come from EVERY coordinator snapshot we still
 *     hold for this class (keyed by author so multiple coordinators
 *     don't clobber each other).
 *   - instructor notes — same.
 *   - survey aggregate is null until parser-survey is real.
 */

import type {
  AssembledSummary,
  AutomationSourceType,
  ClassKey,
  CourseType,
  ExceptionRecord,
} from "../types";
import { query as defaultQuery } from "@/lib/db";

/**
 * Minimal query interface so callers (tests) can inject a fake. Mirrors
 * the relevant subset of `pg.QueryResult`.
 */
export interface QueryRunner {
  // We accept any extension of Record<string, unknown> so test fakes
  // don't have to reach for ts-ignore.
  <T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

interface SnapshotRow extends Record<string, unknown> {
  id: string;
  source_type: AutomationSourceType;
  source_message_id: string | null;
  source_artifact_id: string;
  captured_at: string;
  class_key: ClassKey;
  course_type: CourseType;
  class_date: string;
  location: string;
  participants: string[] | null;
  source_payload: Record<string, unknown> | null;
  participant_hash: string;
  created_at: string;
}

interface ExceptionRow extends Record<string, unknown> {
  id: string;
  automation_id: string;
  artifact_id: string;
  kind: ExceptionRecord["kind"];
  detail: string;
  status: ExceptionRecord["status"];
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

/**
 * Build the SQL fragment that picks the LATEST row per source_type
 * for a given class_key. Postgres-specific (`DISTINCT ON`) — ok because
 * Instinct is Postgres-only.
 */
const LATEST_PER_SOURCE_SQL = `
  SELECT DISTINCT ON (source_type)
    id, source_type, source_message_id, source_artifact_id,
    captured_at, class_key, course_type, class_date, location,
    participants, source_payload, participant_hash, created_at
  FROM instinct_automation_porsche_snapshots
  WHERE class_key = $1
  ORDER BY source_type, captured_at DESC
`;

const OPEN_EXCEPTIONS_SQL = `
  SELECT id, automation_id, artifact_id, kind, detail, status,
         resolved_by, resolved_at, created_at
  FROM instinct_automation_porsche_exceptions
  WHERE automation_id = 'porsche-classes'
    AND status = 'open'
    AND (
      detail ILIKE $1
      OR EXISTS (
        SELECT 1 FROM instinct_automation_porsche_snapshots s
        WHERE s.source_artifact_id = instinct_automation_porsche_exceptions.artifact_id
          AND s.class_key = $2
      )
    )
  ORDER BY created_at DESC
`;

/**
 * Pull the author label out of a coordinator/instructor source_payload.
 * Coordinator snapshots use `coordinator_name`; instructor snapshots
 * use `instructor_name`. Falls back to email or "<unknown>".
 */
function authorOf(
  payload: Record<string, unknown> | null,
  kind: "coordinator" | "instructor",
): string {
  if (!payload) return "<unknown>";
  const nameKey = kind === "coordinator" ? "coordinator_name" : "instructor_name";
  const emailKey = kind === "coordinator" ? "coordinator_email" : "instructor_email";
  const name = payload[nameKey];
  if (typeof name === "string" && name.trim()) return name.trim();
  const email = payload[emailKey];
  if (typeof email === "string" && email.trim()) return email.trim();
  return "<unknown>";
}

/**
 * Render a free-text "note" by joining the most informative free-text
 * answers from a Cognito snapshot. Skips Yes/No-only answers and the
 * identity fields (Name / Email / Class / Class Date / Class Location).
 *
 * The renderer can later pivot to per-section grouping by walking
 * `source_payload.sections` directly; this helper just gives a single
 * paragraph for use in the print-friendly UI.
 */
function noteOf(payload: Record<string, unknown> | null): string {
  if (!payload) return "";
  const sections = payload.sections;
  if (!Array.isArray(sections)) return "";
  const SKIP_LABELS = new Set([
    "Name",
    "Email",
    "Class",
    "Class Date",
    "Class Location",
    "Total number of participants",
  ]);
  const out: string[] = [];
  for (const section of sections as Array<{
    heading: string;
    fields: Array<{ label: string; value: string }>;
  }>) {
    for (const field of section.fields) {
      if (SKIP_LABELS.has(field.label)) continue;
      const v = (field.value ?? "").trim();
      if (!v) continue;
      // Collapse "Yes/No" answers to just the label question — they're
      // implicit from the follow-up "Please provide details:" answer.
      if (v === "Yes" || v === "No") continue;
      out.push(`${field.label}: ${v}`);
    }
  }
  return out.join("\n");
}

export interface AssembleOptions {
  /** Inject a custom query runner — defaults to `query` from @/lib/db. */
  query?: QueryRunner;
  /** Override the "now" timestamp used in `generated_at` (for tests). */
  now?: () => string;
}

/**
 * Stream B's contract entrypoint. Returns null when the class has no
 * snapshots at all (route → 404).
 */
export async function assemblePorscheClassSummary(
  class_key: ClassKey,
  opts: AssembleOptions = {},
): Promise<AssembledSummary | null> {
  const q: QueryRunner = (opts.query ??
    (defaultQuery as unknown as QueryRunner));

  const snapshotsResult = await q<SnapshotRow>(LATEST_PER_SOURCE_SQL, [class_key]);
  const snapshots = snapshotsResult.rows;

  if (snapshots.length === 0) return null;

  // Pick a "primary" snapshot to source class identity from. Prefer the
  // xlsx (canonical participant list); fall back to any other source.
  const xlsx = snapshots.find((r) => r.source_type === "porsche_xlsx");
  const primary = xlsx ?? snapshots[0];

  // Source counts — for now each source_type has 0 or 1 latest row, so
  // counts are 0/1. Stream A's full table query (or a follow-up
  // aggregator) can populate "how many snapshots ever for this class"
  // per source_type later; the contract doesn't dictate semantics
  // beyond "Source counts by parser".
  const sources: Record<AutomationSourceType, number> = {
    porsche_xlsx: 0,
    cognito_coordinator: 0,
    cognito_instructor: 0,
    survey: 0,
  };
  for (const row of snapshots) sources[row.source_type] += 1;

  // Participants come from the xlsx snapshot when available — that's
  // the canonical roster. Fall back to whichever snapshot has the most
  // names so we never render a totally empty list when xlsx is missing.
  let participants: string[] = [];
  if (xlsx?.participants?.length) {
    participants = xlsx.participants;
  } else {
    const best = [...snapshots].sort(
      (a, b) => (b.participants?.length ?? 0) - (a.participants?.length ?? 0),
    )[0];
    participants = best.participants ?? [];
  }

  // Coordinator + instructor notes — one entry per author. Latest-wins
  // is already enforced by the DISTINCT ON above; we just project.
  const coordinatorRows = snapshots.filter(
    (r) => r.source_type === "cognito_coordinator",
  );
  const instructorRows = snapshots.filter(
    (r) => r.source_type === "cognito_instructor",
  );

  const coordinator_notes = coordinatorRows.map((row) => ({
    author: authorOf(row.source_payload, "coordinator"),
    note: noteOf(row.source_payload),
  }));
  const instructor_notes = instructorRows.map((row) => ({
    author: authorOf(row.source_payload, "instructor"),
    note: noteOf(row.source_payload),
  }));

  // Open exceptions touching this class — either the exception row
  // mentions the class_key in its detail OR the artifact it complains
  // about has a snapshot under this class_key.
  const exceptionsResult = await q<ExceptionRow>(OPEN_EXCEPTIONS_SQL, [
    `%${class_key}%`,
    class_key,
  ]);
  const open_exceptions: ExceptionRecord[] = exceptionsResult.rows.map(
    (row) => ({
      id: row.id,
      automation_id: "porsche-classes",
      artifact_id: row.artifact_id,
      kind: row.kind,
      detail: row.detail,
      status: row.status,
      resolved_by: row.resolved_by,
      resolved_at: row.resolved_at,
      created_at: row.created_at,
    }),
  );

  const generated_at = opts.now?.() ?? new Date().toISOString();

  return {
    class_key,
    course_type: primary.course_type,
    class_date: primary.class_date,
    location: primary.location,
    sources,
    participants,
    coordinator_notes,
    instructor_notes,
    survey: null, // Stub until parser-survey is real.
    open_exceptions,
    generated_at,
  };
}
