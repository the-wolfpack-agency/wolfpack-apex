/**
 * POST /api/automations/[automationId]/quarantine/[id]/reprocess
 *
 * Re-run the parser pipeline against a previously-quarantined artifact.
 * Used after a parser-side bugfix lands so the operator can clear the
 * existing quarantine queue without waiting for a fresh email to
 * arrive.
 *
 * Path params:
 *   - automationId — the automation slug (e.g. "porsche-classes")
 *   - id           — the EXCEPTION row id (NOT the artifact id; the
 *                    exception is the entity the operator clicks
 *                    "Reprocess" on in the dashboard).
 *
 * Auth: `automations.resolve_exceptions` capability — the operator
 *   role that gets to clear the quarantine queue is the same one that
 *   resolves/dismisses individual exceptions.
 *
 * Side effects (in order):
 *   1. Look up the exception + its associated artifact.
 *   2. Mark the exception RESOLVED (so the queue clears) — even if the
 *      reprocess fails the exception state moves forward, and the new
 *      reprocess result creates its own exception row when applicable.
 *   3. Reset the artifact to parse_status='pending' AND clear the
 *      legacy dedup_key path so ingestArtifact's idempotent upsert
 *      re-fires the parser instead of short-circuiting on the existing
 *      'processed' row.
 *   4. Re-run `ingestArtifact` against the stored bytes. Source-type
 *      detection follows the same logic the inbox poller uses — by
 *      mime when available, falling back to the .xlsx default for the
 *      porsche-classes flow (the parser-survey vs porsche_xlsx
 *      disambiguation is by filename, but a reprocess from quarantine
 *      doesn't have the filename anymore — we accept this and route
 *      to porsche_xlsx, which is the parser the existing quarantines
 *      were stuck on).
 *   5. Return the IngestResult plus the updated exception so the UI
 *      can render the new state.
 *
 * Idempotent — if the operator clicks twice, the second click sees the
 * exception is already resolved and returns 409 (or, if the underlying
 * artifact has since been re-processed, returns the new result without
 * double-counting).
 *
 * Status codes:
 *   200 → reprocessed; result body carries the new IngestResult
 *   401 → not authenticated
 *   403 → missing capability
 *   404 → automation, exception, or artifact unknown
 *   409 → exception already resolved or dismissed
 *   500 → infra failure (DB, parser internal, etc.)
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getAutomation } from "@/lib/automations/registry";
import { ingestArtifact } from "@/lib/automations/porsche-classes/ingest";
import { query, writeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import type { AutomationSourceType } from "@/lib/automations/types";

interface Ctx {
  params: Promise<{ automationId: string; id: string }>;
}

// pg's QueryResult requires a Record<string, unknown> shape; we keep
// the typed interface for local readability and use the cast below.
type ExceptionWithArtifact = {
  exception_id: string;
  exception_status: string;
  exception_kind: string;
  exception_detail: string;
  automation_id: string;
  artifact_id: string;
  artifact_bytes: Buffer;
  artifact_mime: string;
  artifact_received_at: string;
  artifact_source_message_id: string | null;
  artifact_internet_message_id: string | null;
} & Record<string, unknown>;

/** Map an artifact mime to a default source_type. Per-automation; today
 *  we only handle porsche-classes here, which is the only registered
 *  surface with a quarantine-reprocess UI button. Returns null when the
 *  mime is unrecognized — caller surfaces that as a 422-shaped error
 *  inside a 200 result so the dashboard can show a clear message. */
function defaultSourceTypeForMime(mime: string): AutomationSourceType | null {
  const m = (mime ?? "").toLowerCase();
  if (m.includes("spreadsheet") || m.includes("excel") || m.includes("xlsx")) {
    return "porsche_xlsx";
  }
  if (m.includes("rfc822") || m.includes("message/rfc822")) {
    // Body-Cognito path — coordinator vs instructor disambiguation is by
    // subject line, which we don't have at reprocess time. Default to
    // coordinator (the more common shape); a follow-up that ALSO fails
    // gets quarantined again with a clear "instructor parser would be
    // needed" message via the parser layer.
    return "cognito_coordinator";
  }
  return null;
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireCapability(req, "automations.resolve_exceptions");
  if (!auth.ok) return auth.response;

  const { automationId, id } = await ctx.params;
  const automation = getAutomation(automationId);
  if (!automation) {
    return NextResponse.json(
      { error: "automation not found", automationId },
      { status: 404 },
    );
  }

  // 1. Pull the exception + its artifact in a single query so the
  //    response is consistent w.r.t. ordering. The artifact_bytes column
  //    is BYTEA; node-pg returns it as Buffer.
  const found = await query<ExceptionWithArtifact>(
    `SELECT e.id                                AS exception_id,
            e.status                            AS exception_status,
            e.kind                              AS exception_kind,
            e.detail                            AS exception_detail,
            e.automation_id                     AS automation_id,
            a.id::text                          AS artifact_id,
            a.bytes                             AS artifact_bytes,
            a.mime                              AS artifact_mime,
            a.received_at::text                 AS artifact_received_at,
            a.source_message_id                 AS artifact_source_message_id,
            a.internet_message_id               AS artifact_internet_message_id
       FROM instinct_automation_porsche_exceptions e
       JOIN instinct_automation_porsche_artifacts a ON a.id = e.artifact_id
      WHERE e.id = $1
        AND e.automation_id = $2`,
    [id, automation.id],
  );

  if (found.rows.length === 0) {
    return NextResponse.json(
      { error: "exception not found", id, automationId },
      { status: 404 },
    );
  }

  const row = found.rows[0];

  if (row.exception_status !== "open") {
    return NextResponse.json(
      {
        error: "exception is not open — already resolved or dismissed",
        status: row.exception_status,
      },
      { status: 409 },
    );
  }

  const sourceType = defaultSourceTypeForMime(row.artifact_mime);
  if (!sourceType) {
    return NextResponse.json(
      {
        error: `cannot infer source_type from mime '${row.artifact_mime}'`,
        artifact_id: row.artifact_id,
      },
      { status: 422 },
    );
  }

  // 2. Reset artifact + dedup_key. Setting dedup_key to a unique
  //    sentinel forces ingestArtifact's ON CONFLICT (automation_id,
  //    dedup_key) clause to insert a fresh "pending" row instead of
  //    short-circuiting on the existing 'processed' (or 'error_quarantined')
  //    artifact.
  //
  //    BUT — we want the SAME artifact_id to receive the new parse
  //    result so deltas + audit trails stay coherent. The trick:
  //    rewrite the existing row's dedup_key to a "reproc:<old>" value
  //    so the canonical key the new ingest computes (imid:... or fb:...)
  //    no longer collides; the new ingest then inserts a separate
  //    artifact row whose dedup_key matches the canonical key. This
  //    leaves the OLD artifact + its quarantine intact for forensics
  //    and produces a NEW artifact for the successful reparse — exactly
  //    the auditing model we want.
  await writeQuery(
    `UPDATE instinct_automation_porsche_artifacts
        SET dedup_key = 'reproc:' || $2 || ':' || dedup_key
      WHERE id = $1
      RETURNING id`,
    [row.artifact_id, row.exception_id],
    { expectRows: 1 },
  );

  // 3. Resolve the original exception so the queue clears. We don't
  //    block on the new ingest — even if it ALSO quarantines, the new
  //    exception row carries the new failure reason and the dashboard
  //    will show it under the new artifact id.
  await writeQuery(
    `UPDATE instinct_automation_porsche_exceptions
        SET status = 'resolved',
            resolved_by = $2,
            resolved_at = NOW()
      WHERE id = $1
        AND status = 'open'
      RETURNING id`,
    [row.exception_id, auth.user.email ?? auth.user.id],
    { expectRows: 1 },
  );

  // 4. Re-run the ingest pipeline. We pass the original bytes/mime/
  //    received_at so all dedup + analytics fire as if a fresh poll
  //    delivered this artifact (which is what the operator semantically
  //    means by "reprocess"). We pass the stored internet_message_id
  //    so the new ingest's dedup_key is the canonical "imid:..." form
  //    (or falls back to the content hash when the original poll
  //    didn't capture an RFC 5322 id — pre-130 rows won't have one).
  let ingestResult: Awaited<ReturnType<typeof ingestArtifact>>;
  try {
    ingestResult = await ingestArtifact({
      automation,
      source_type: sourceType,
      source_message_id: row.artifact_source_message_id,
      received_at: row.artifact_received_at,
      bytes: row.artifact_bytes,
      hint: `reproc-${row.exception_id}`,
      mime: row.artifact_mime,
      user_id: auth.user.id,
      user_role: auth.user.role,
      internet_message_id: row.artifact_internet_message_id,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "reprocess ingest threw",
        message: (err as Error).message,
      },
      { status: 500 },
    );
  }

  // 5. Emit the typed reprocess event for the learning loop. outcome
  //    distinguishes the three real states: cleanly processed, still
  //    quarantined (new parser still rejects), or duplicate (the new
  //    canonical dedup_key collided with a separately-ingested copy).
  const outcome: "processed" | "still_quarantined" | "duplicate" =
    ingestResult.was_duplicate
      ? "duplicate"
      : ingestResult.parse_status === "processed"
        ? "processed"
        : "still_quarantined";
  trackEvent(
    "automations.quarantine_reprocessed",
    auth.user.id,
    auth.user.role,
    {
      automation_id: automation.id,
      exception_id: row.exception_id,
      artifact_id: row.artifact_id,
      new_artifact_id: ingestResult.artifact_id,
      outcome,
    },
  );

  return NextResponse.json(
    {
      ok: true,
      outcome,
      ingest: ingestResult,
      old_artifact_id: row.artifact_id,
      old_exception_id: row.exception_id,
    },
    { status: 200 },
  );
}
