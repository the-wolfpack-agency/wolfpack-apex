/**
 * GET /api/automations/porsche-classes/diag
 *   ?course=BA101&date=2026-04-20
 *
 * Diagnostic endpoint — returns the raw DB state for a (course, date)
 * pair so an operator can see exactly what's in the snapshot, artifact,
 * exception, and override tables when a class summary page looks empty.
 *
 * Built 2026-04-27 after a long debug cycle on the BA101|Ritz Carlton
 * page where Backfill kept reporting "✓ snapshot ok" but the assembler
 * surfaced no coordinator notes. Without this endpoint, every theory
 * about where the data went required guessing; with it, the truth is
 * one HTTP call away.
 *
 * Auth: `automations.view` (read-only — no writes).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { query } from "@/lib/db";

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "automations.view");
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const course = url.searchParams.get("course") || "BA101";
  const date = url.searchParams.get("date") || "2026-04-20";

  const snapshots = await query<{
    id: string;
    class_key: string;
    source_type: string;
    course_type: string;
    class_date: string;
    location: string;
    captured_at: string;
    participant_count: number | null;
    has_payload: boolean;
    payload_keys: string[];
    coordinator_name: string | null;
    form_title: string | null;
  }>(
    `SELECT
       id::text,
       class_key,
       source_type,
       course_type,
       class_date::text,
       location,
       captured_at::text,
       array_length(participants, 1) AS participant_count,
       (source_payload IS NOT NULL) AS has_payload,
       CASE WHEN source_payload IS NOT NULL
         THEN ARRAY(SELECT jsonb_object_keys(source_payload)) ELSE ARRAY[]::text[] END
         AS payload_keys,
       source_payload->>'coordinator_name' AS coordinator_name,
       source_payload->>'form_title' AS form_title
       FROM instinct_automation_porsche_snapshots
      WHERE course_type = $1 AND class_date = $2::date
      ORDER BY captured_at DESC`,
    [course, date],
  );

  const artifacts = await query<{
    id: string;
    source_message_id: string | null;
    source_type: string;
    parse_status: string;
    created_at: string;
    hint: string | null;
  }>(
    `SELECT id::text, source_message_id, source_type, parse_status,
            created_at::text, hint
       FROM instinct_automation_porsche_artifacts
      WHERE created_at > NOW() - interval '24 hours'
      ORDER BY created_at DESC
      LIMIT 30`,
  );

  const exceptions = await query<{
    id: string;
    artifact_id: string | null;
    kind: string;
    detail: string;
    status: string;
    created_at: string;
  }>(
    `SELECT id::text, artifact_id::text, kind, detail, status,
            created_at::text
       FROM instinct_automation_porsche_exceptions
      WHERE status = 'open' OR created_at > NOW() - interval '24 hours'
      ORDER BY created_at DESC
      LIMIT 30`,
  );

  const overrides = await query<{
    id: string;
    kind: string;
    from_value: string;
    to_value: string;
    created_at: string;
    created_by: string | null;
  }>(
    `SELECT id::text, kind, from_value, to_value,
            created_at::text, created_by
       FROM instinct_automation_porsche_overrides
      WHERE automation_id = 'porsche-classes'
      ORDER BY created_at DESC
      LIMIT 50`,
  );

  return NextResponse.json({
    query: { course, date },
    summary: {
      snapshot_count: snapshots.rows.length,
      distinct_class_keys: [...new Set(snapshots.rows.map((s) => s.class_key))],
      distinct_source_types: [
        ...new Set(snapshots.rows.map((s) => s.source_type)),
      ],
      open_exception_count: exceptions.rows.filter((e) => e.status === "open")
        .length,
      override_count: overrides.rows.length,
    },
    snapshots: snapshots.rows,
    artifacts: artifacts.rows,
    exceptions: exceptions.rows,
    overrides: overrides.rows,
  });
}
