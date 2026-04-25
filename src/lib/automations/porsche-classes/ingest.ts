/**
 * porsche-classes / ingest — orchestrator that takes raw inbound bytes,
 * stores them as an artifact, drives the parser, persists snapshots,
 * computes deltas, and emits analytics.
 *
 * Idempotent on `(source_message_id, content_sha256)` — the artifact
 * unique index is the contract here. A re-poll of the same Graph
 * message id with the same body is a NO-OP at every layer:
 *   - artifact insert returns the existing row (ON CONFLICT DO UPDATE
 *     RETURNING)
 *   - snapshot insert is also ON CONFLICT (source_artifact_id,class_key)
 *     so re-running a parser against the same artifact never duplicates.
 *
 * Failure path (per memory feedback_no_silent_data_loss):
 *   - parser returns ParseFailure → artifact.parse_status =
 *     'error_quarantined' + insert exception row + emit analytics
 *   - any pg / writeQuery error bubbles up; the artifact remains in
 *     'pending' so a follow-up replay is possible.
 *
 * This module is server-only (uses `writeQuery` + `node:crypto`).
 */

import { createHash } from "node:crypto";
import { query, writeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import type {
  AutomationDefinition,
  AutomationSourceType,
  ExceptionKind,
  ParseInput,
  SnapshotInput,
} from "@/lib/automations/types";
import {
  buildClassKey,
  canonicalParticipants,
  participantHash,
} from "./normalize";
import { computeDelta } from "./delta";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface IngestRequest {
  automation: AutomationDefinition;
  source_type: AutomationSourceType;
  source_message_id: string | null;
  received_at: string;
  bytes: Buffer;
  hint: string;
  mime: string;
  /** Email of the user triggering the ingest (for analytics + audit). */
  user_id: string;
  user_role: string;
}

export interface IngestResult {
  artifact_id: string;
  /** True when this artifact was already ingested before — no-op path. */
  was_duplicate: boolean;
  parse_status: "processed" | "error_quarantined";
  snapshots_written: number;
  deltas_written: number;
  exception_id?: string;
}

/* ------------------------------------------------------------------ */
/* Public entry point                                                  */
/* ------------------------------------------------------------------ */

export async function ingestArtifact(
  req: IngestRequest,
): Promise<IngestResult> {
  const automationId = req.automation.id;

  // 1. Compute content sha256 — half of the idempotency key.
  const sha = createHash("sha256").update(req.bytes).digest("hex");

  // 2. Upsert the artifact row. ON CONFLICT we keep the existing row
  //    and return its id + parse_status so we can short-circuit duplicates.
  const upsert = await writeQuery<{
    id: string;
    parse_status: string;
    inserted: boolean;
  }>(
    `INSERT INTO instinct_automation_porsche_artifacts
       (automation_id, source_message_id, received_at, bytes,
        content_sha256, mime, parse_status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')
     ON CONFLICT (source_message_id, content_sha256) DO UPDATE SET
       -- Touch a benign column so RETURNING gives us the existing row.
       mime = EXCLUDED.mime
     RETURNING id, parse_status, (xmax = 0) AS inserted`,
    [
      automationId,
      req.source_message_id,
      req.received_at,
      req.bytes,
      sha,
      req.mime,
    ],
    { expectRows: 1 },
  );

  const artifactRow = upsert.rows[0];
  const artifactId = artifactRow.id;

  // Duplicate-and-already-processed: no-op at every downstream layer.
  if (!artifactRow.inserted && artifactRow.parse_status === "processed") {
    return {
      artifact_id: artifactId,
      was_duplicate: true,
      parse_status: "processed",
      snapshots_written: 0,
      deltas_written: 0,
    };
  }

  // 3. Pick the parser for this source_type. Stream B will register
  //    cognito_* / survey here; for now if a non-xlsx source arrives,
  //    we record a needs_review exception (don't drop, don't pretend).
  const parser = req.automation.parsers[req.source_type];
  if (!parser) {
    return await quarantine({
      artifactId,
      automationId,
      source_message_id: req.source_message_id,
      reason: `no parser registered for source_type=${req.source_type}`,
      exceptionKind: "parse_failure",
      user_id: req.user_id,
      user_role: req.user_role,
      // Use 'needs_review' here because the failure is a CONFIGURATION
      // gap, not a malformed input — Stream B's parser will land later.
      finalStatus: "needs_review",
    });
  }

  const parseInput: ParseInput = {
    bytes: req.bytes,
    hint: req.hint,
    received_at: req.received_at,
    source_message_id: req.source_message_id,
    source_artifact_id: artifactId,
  };

  let result;
  try {
    result = await parser(parseInput);
  } catch (err) {
    return await quarantine({
      artifactId,
      automationId,
      source_message_id: req.source_message_id,
      reason: `parser threw: ${(err as Error).message}`,
      exceptionKind: "parse_failure",
      user_id: req.user_id,
      user_role: req.user_role,
      finalStatus: "error_quarantined",
    });
  }

  if (!result.ok) {
    return await quarantine({
      artifactId,
      automationId,
      source_message_id: req.source_message_id,
      reason: result.error,
      exceptionKind: result.exception_kind,
      user_id: req.user_id,
      user_role: req.user_role,
      finalStatus: "error_quarantined",
    });
  }

  // 4. Persist snapshots + compute deltas (per class_key).
  let snapshotsWritten = 0;
  let deltasWritten = 0;

  for (const snap of result.snapshots) {
    const written = await persistSnapshot(automationId, snap);
    if (written.created) snapshotsWritten += 1;
    if (written.delta_id) {
      deltasWritten += 1;
      trackEvent("automations.delta_computed", req.user_id, req.user_role, {
        automation_id: automationId,
        class_key: written.class_key,
        added: written.added,
        dropped: written.dropped,
        is_baseline: written.is_baseline,
      });
    }
  }

  // 5. Mark artifact processed. RETURNING id so writeQuery's
  //    expectRows guard fires if the WHERE clause finds nothing — that
  //    would mean the artifact disappeared between insert and update,
  //    which is the kind of silent loss we MUST surface.
  await writeQuery(
    `UPDATE instinct_automation_porsche_artifacts
        SET parse_status = 'processed'
      WHERE id = $1
      RETURNING id`,
    [artifactId],
    { expectRows: 1 },
  );

  trackEvent("automations.artifact_ingested", req.user_id, req.user_role, {
    automation_id: automationId,
    source_type: req.source_type,
    source_message_id: req.source_message_id ?? "",
    classes: snapshotsWritten,
  });

  return {
    artifact_id: artifactId,
    was_duplicate: false,
    parse_status: "processed",
    snapshots_written: snapshotsWritten,
    deltas_written: deltasWritten,
  };
}

/* ------------------------------------------------------------------ */
/* persistSnapshot — write one snapshot + its delta vs. the previous   */
/* ------------------------------------------------------------------ */

interface PersistResult {
  created: boolean;
  snapshot_id: string;
  class_key: string;
  delta_id: string | null;
  added: number;
  dropped: number;
  is_baseline: boolean;
}

async function persistSnapshot(
  automationId: string,
  snap: SnapshotInput,
): Promise<PersistResult> {
  const class_key = buildClassKey(
    snap.class.course_type,
    snap.class.class_date,
    snap.class.location,
  );
  const canonical = canonicalParticipants(snap.class.participants);
  const pHash = participantHash(canonical);

  // 1. Upsert snapshot. ON CONFLICT (source_artifact_id, class_key) we
  //    keep the existing row so re-runs are idempotent.
  const ins = await writeQuery<{
    id: string;
    inserted: boolean;
  }>(
    `INSERT INTO instinct_automation_porsche_snapshots
       (source_type, source_message_id, source_artifact_id,
        captured_at, class_key, course_type, class_date, location,
        participants, participant_hash, source_payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             $9::jsonb, $10, $11::jsonb)
     ON CONFLICT (source_artifact_id, class_key) DO UPDATE SET
       captured_at = EXCLUDED.captured_at
     RETURNING id, (xmax = 0) AS inserted`,
    [
      snap.source_type,
      snap.source_message_id,
      snap.source_artifact_id,
      snap.captured_at,
      class_key,
      snap.class.course_type,
      snap.class.class_date,
      snap.class.location,
      JSON.stringify(canonical),
      pHash,
      JSON.stringify(snap.source_payload ?? {}),
    ],
    { expectRows: 1 },
  );

  const snapshot_id = ins.rows[0].id;
  const created = ins.rows[0].inserted;

  if (!created) {
    // Re-ingest of the same artifact — no new snapshot row, no new delta.
    return {
      created: false,
      snapshot_id,
      class_key,
      delta_id: null,
      added: 0,
      dropped: 0,
      is_baseline: false,
    };
  }

  // 2. Compute delta vs. the previous snapshot for this class_key. We
  //    explicitly EXCLUDE the just-inserted snapshot id so a baseline-
  //    detection on first observation works.
  const prev = await query<{
    id: string;
    participants: string[];
  }>(
    `SELECT id,
            (participants)::jsonb AS participants
       FROM instinct_automation_porsche_snapshots
      WHERE class_key = $1
        AND id <> $2
      ORDER BY captured_at DESC, created_at DESC
      LIMIT 1`,
    [class_key, snapshot_id],
  );

  // Note: pg returns jsonb arrays as plain JS arrays; we still cast to
  // string[] for type safety. If the column was somehow non-array
  // (defensive only) we coerce to [] so downstream Sets stay sane.
  const prevParticipants =
    prev.rows.length === 0
      ? null
      : Array.isArray(prev.rows[0].participants)
        ? (prev.rows[0].participants as string[])
        : [];

  const delta = computeDelta(prevParticipants, canonical);

  const deltaIns = await writeQuery<{ id: string }>(
    `INSERT INTO instinct_automation_porsche_deltas
       (automation_id, class_key, prev_snapshot_id, curr_snapshot_id,
        added, dropped, net_change, is_baseline)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)
     RETURNING id`,
    [
      automationId,
      class_key,
      prev.rows[0]?.id ?? null,
      snapshot_id,
      JSON.stringify(delta.added),
      JSON.stringify(delta.dropped),
      delta.net_change,
      delta.is_baseline,
    ],
    { expectRows: 1 },
  );

  return {
    created: true,
    snapshot_id,
    class_key,
    delta_id: deltaIns.rows[0].id,
    added: delta.added.length,
    dropped: delta.dropped.length,
    is_baseline: delta.is_baseline,
  };
}

/* ------------------------------------------------------------------ */
/* Quarantine path — flip artifact + write exception row               */
/* ------------------------------------------------------------------ */

interface QuarantineArgs {
  artifactId: string;
  automationId: string;
  source_message_id: string | null;
  reason: string;
  exceptionKind: ExceptionKind;
  user_id: string;
  user_role: string;
  finalStatus: "error_quarantined" | "needs_review";
}

async function quarantine(args: QuarantineArgs): Promise<IngestResult> {
  await writeQuery(
    `UPDATE instinct_automation_porsche_artifacts
        SET parse_status = $2
      WHERE id = $1
      RETURNING id`,
    [args.artifactId, args.finalStatus],
    { expectRows: 1 },
  );

  const exc = await writeQuery<{ id: string }>(
    `INSERT INTO instinct_automation_porsche_exceptions
       (automation_id, artifact_id, kind, detail, status)
     VALUES ($1, $2, $3, $4, 'open')
     RETURNING id`,
    [args.automationId, args.artifactId, args.exceptionKind, args.reason],
    { expectRows: 1 },
  );

  trackEvent("automations.artifact_quarantined", args.user_id, args.user_role, {
    automation_id: args.automationId,
    source_message_id: args.source_message_id ?? "",
    reason: args.reason,
    exception_kind: args.exceptionKind,
  });

  return {
    artifact_id: args.artifactId,
    was_duplicate: false,
    // The "result" parse_status here is the FINAL status of the artifact
    // — quarantine is the terminal failure path so we surface that.
    parse_status: "error_quarantined",
    snapshots_written: 0,
    deltas_written: 0,
    exception_id: exc.rows[0].id,
  };
}
