/**
 * GET /api/automations/porsche-classes/diag
 *   ?course=BA101&date=2026-04-20
 *
 * Diagnostic endpoint — returns the raw DB state for a (course, date)
 * pair so an operator can see exactly what's in the snapshot, artifact,
 * exception, and override tables when a class summary page looks empty.
 *
 * Each query is wrapped in try/catch — if one fails, the others still
 * return data and the failure is reported inline. That way a column
 * mismatch in one section can't blank the whole diagnostic response.
 *
 * Auth: `automations.view` (read-only).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { query } from "@/lib/db";

async function safeQuery<T extends Record<string, unknown>>(
  label: string,
  sql: string,
  params: unknown[],
): Promise<{ rows: T[]; error?: string }> {
  try {
    const r = await query<T>(sql, params);
    return { rows: r.rows };
  } catch (err) {
    return { rows: [], error: `${label}: ${(err as Error).message}` };
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "automations.view");
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const course = url.searchParams.get("course") || "BA101";
  const date = url.searchParams.get("date") || "2026-04-20";

  // Snapshots — participants is jsonb so use jsonb_array_length, not array_length.
  const snapshots = await safeQuery<{
    id: string;
    class_key: string;
    source_type: string;
    course_type: string;
    class_date: string;
    location: string;
    captured_at: string;
    participant_count: number;
    payload_keys: string[];
    coordinator_name: string | null;
    instructor_name: string | null;
    form_title: string | null;
    source_artifact_id: string;
  }>(
    "snapshots",
    `SELECT
       id::text,
       class_key,
       source_type,
       course_type,
       class_date::text,
       location,
       captured_at::text,
       jsonb_array_length(COALESCE(participants, '[]'::jsonb)) AS participant_count,
       ARRAY(SELECT jsonb_object_keys(source_payload)) AS payload_keys,
       source_payload->>'coordinator_name' AS coordinator_name,
       source_payload->>'instructor_name'  AS instructor_name,
       source_payload->>'form_title'       AS form_title,
       source_artifact_id::text
       FROM instinct_automation_porsche_snapshots
      WHERE course_type = $1 AND class_date = $2::date
      ORDER BY captured_at DESC`,
    [course, date],
  );

  // Artifacts — no `hint` column; the schema is id/automation_id/source_message_id/
  // received_at/bytes/content_sha256/mime/parse_status/created_at.
  const artifacts = await safeQuery<{
    id: string;
    source_message_id: string | null;
    parse_status: string;
    mime: string;
    received_at: string;
    created_at: string;
    content_sha256: string;
    byte_count: number;
  }>(
    "artifacts",
    `SELECT id::text, source_message_id, parse_status, mime,
            received_at::text, created_at::text, content_sha256,
            octet_length(bytes) AS byte_count
       FROM instinct_automation_porsche_artifacts
      WHERE created_at > NOW() - interval '24 hours'
      ORDER BY created_at DESC
      LIMIT 30`,
    [],
  );

  const exceptions = await safeQuery<{
    id: string;
    artifact_id: string;
    kind: string;
    detail: string;
    status: string;
    created_at: string;
  }>(
    "exceptions",
    `SELECT id::text, artifact_id::text, kind, detail, status,
            created_at::text
       FROM instinct_automation_porsche_exceptions
      WHERE status = 'open' OR created_at > NOW() - interval '24 hours'
      ORDER BY created_at DESC
      LIMIT 30`,
    [],
  );

  const overrides = await safeQuery<{
    id: string;
    kind: string;
    from_value: string;
    to_value: string;
    created_at: string;
    created_by: string;
    reason: string | null;
  }>(
    "overrides",
    `SELECT id::text, kind, from_value, to_value,
            created_at::text, created_by, reason
       FROM instinct_automation_porsche_overrides
      WHERE automation_id = 'porsche-classes'
      ORDER BY created_at DESC
      LIMIT 50`,
    [],
  );

  /* Optional ?from=<class_key>&to=<class_key> participant-overlap test —
     answers "are these the same physical class?" before clicking Merge.
     For each class_key, pulls (a) the porsche_xlsx roster's participants
     and (b) the cognito_coordinator's free-text answers, and counts
     how many roster names from one class appear as substrings in the
     other class's free-text. Provides hard evidence for class_match
     overrides; replaces "trust the AI's reasoning" with explicit data. */
  const fromKey = url.searchParams.get("from");
  const toKey = url.searchParams.get("to");
  let overlap: {
    from: string;
    to: string;
    from_participants: string[];
    to_participants: string[];
    same_count: boolean;
    name_matches_in_text: { name: string; appears_in: "from" | "to" | "both" }[];
    error?: string;
  } | null = null;

  if (fromKey && toKey) {
    try {
      const overlapRows = await query<{
        class_key: string;
        source_type: string;
        participants: unknown;
        free_text_blob: string | null;
      }>(
        `SELECT class_key, source_type, participants,
                (SELECT string_agg(value::text, ' ')
                   FROM jsonb_each_text(source_payload->'fields')) AS free_text_blob
           FROM instinct_automation_porsche_snapshots
          WHERE class_key = ANY($1::text[])`,
        [[fromKey, toKey]],
      );

      const lower = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, "");
      const tokenize = (s: string) =>
        new Set(lower(s).split(/\s+/).filter((t) => t.length >= 3));

      const namesFor = (k: string): string[] => {
        const xlsx = overlapRows.rows.find(
          (r) => r.class_key === k && r.source_type === "porsche_xlsx",
        );
        if (!xlsx || !Array.isArray(xlsx.participants)) return [];
        return xlsx.participants
          .filter((n): n is string => typeof n === "string")
          .map((n) => n);
      };

      const textFor = (k: string): string =>
        overlapRows.rows
          .filter((r) => r.class_key === k && r.source_type !== "porsche_xlsx")
          .map((r) => r.free_text_blob ?? "")
          .join(" ");

      const fromParticipants = namesFor(fromKey);
      const toParticipants = namesFor(toKey);
      const fromText = textFor(fromKey);
      const toText = textFor(toKey);
      const fromTokens = tokenize(fromText);
      const toTokens = tokenize(toText);

      const matches: { name: string; appears_in: "from" | "to" | "both" }[] = [];
      const checkName = (name: string) => {
        const parts = lower(name).split(/\s+/).filter((t) => t.length >= 3);
        if (parts.length === 0) return;
        const inFrom = parts.some((p) => fromTokens.has(p));
        const inTo = parts.some((p) => toTokens.has(p));
        if (inFrom && inTo) matches.push({ name, appears_in: "both" });
        else if (inFrom) matches.push({ name, appears_in: "from" });
        else if (inTo) matches.push({ name, appears_in: "to" });
      };
      // Cross-reference: do FROM's roster names appear in TO's coordinator text?
      // And vice versa? Either is strong evidence of same class.
      [...fromParticipants, ...toParticipants].forEach(checkName);

      overlap = {
        from: fromKey,
        to: toKey,
        from_participants: fromParticipants,
        to_participants: toParticipants,
        same_count:
          fromParticipants.length > 0 &&
          fromParticipants.length === toParticipants.length,
        name_matches_in_text: matches,
      };
    } catch (err) {
      overlap = {
        from: fromKey,
        to: toKey,
        from_participants: [],
        to_participants: [],
        same_count: false,
        name_matches_in_text: [],
        error: (err as Error).message,
      };
    }
  }

  const errors = [snapshots.error, artifacts.error, exceptions.error, overrides.error]
    .filter((e): e is string => Boolean(e));

  return NextResponse.json({
    query: { course, date, from: fromKey, to: toKey },
    overlap,
    summary: {
      snapshot_count: snapshots.rows.length,
      distinct_class_keys: [...new Set(snapshots.rows.map((s) => s.class_key))],
      distinct_source_types: [...new Set(snapshots.rows.map((s) => s.source_type))],
      open_exception_count: exceptions.rows.filter((e) => e.status === "open").length,
      override_count: overrides.rows.length,
      errors,
    },
    snapshots: snapshots.rows,
    artifacts: artifacts.rows,
    exceptions: exceptions.rows,
    overrides: overrides.rows,
  });
}
