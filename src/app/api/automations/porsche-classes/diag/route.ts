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

  const errors = [snapshots.error, artifacts.error, exceptions.error, overrides.error]
    .filter((e): e is string => Boolean(e));

  return NextResponse.json({
    query: { course, date },
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
