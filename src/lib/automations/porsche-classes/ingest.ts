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
  CourseType,
  ExceptionKind,
  ParseInput,
  SnapshotInput,
} from "@/lib/automations/types";
import { computeDedupKey } from "@/lib/automations/dedup";
import {
  buildClassKey,
  canonicalParticipants,
  participantHash,
} from "./normalize";
import { computeDelta } from "./delta";
import {
  decodeSurveyRows,
  parseMultiClassFilename,
  splitMixedSurvey,
  type CandidateClass,
} from "./parser-survey";
import { recordAction } from "./audit-repo";
import { notifySummaryReadyIfTransition } from "./notify-summary-ready";

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
  /**
   * Optional class identity override forwarded to the parser via
   * ParseInput.class_override. Used by the manual-ingest path so a
   * survey upload from a specific class's page is deterministically
   * assigned to THAT class instead of routed by filename regex.
   */
  class_override?: ParseInput["class_override"];
  /** RFC 5322 Message-Id header from Graph (when available). PRIMARY
   *  half of the dedup key — see src/lib/automations/dedup.ts. Pollers
   *  pass this through; manual uploads leave it null and the dedup
   *  helper falls back to a content-derived hash. */
  internet_message_id?: string | null;
  /** Subject line (used by the dedup fallback hash when
   *  internet_message_id is missing). */
  subject?: string | null;
  /** From address (used by the dedup fallback hash when
   *  internet_message_id is missing). */
  from_address?: string | null;
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

  // 1. Compute content sha256 — kept around for forensics + the legacy
  //    UNIQUE index on (source_message_id, content_sha256) which the
  //    table still carries during the migration window. The NEW
  //    idempotency key is artifacts.dedup_key (migration 130).
  //    TODO(2026-Q3): drop legacy dedup index in migration 131+ after
  //    2026-06-01 once the new key has been live for >1 week.
  const sha = createHash("sha256").update(req.bytes).digest("hex");

  // 2. Compute the canonical dedup key. PRIMARY: RFC 5322
  //    internet_message_id (globally unique, stable across mailboxes).
  //    FALLBACK: SHA-256 over (subject, from, received, body-first-512)
  //    when no internet_message_id is available (direct uploads + rare
  //    Graph corner cases). See src/lib/automations/dedup.ts.
  const dedup = computeDedupKey({
    internet_message_id: req.internet_message_id ?? null,
    subject: req.subject ?? null,
    from: req.from_address ?? null,
    received_iso: req.received_at,
    bytes: req.bytes,
  });

  // 3. Upsert the artifact row. ON CONFLICT on the new (automation_id,
  //    dedup_key) UNIQUE index — this is the contract that prevents
  //    re-ingesting the same RFC-5322 message even when Graph hands us
  //    a different mailbox-scoped id (the false-positive duplicate bug
  //    fixed by migration 130).
  const upsert = await writeQuery<{
    id: string;
    parse_status: string;
    inserted: boolean;
  }>(
    `INSERT INTO instinct_automation_porsche_artifacts
       (automation_id, source_message_id, received_at, bytes,
        content_sha256, mime, parse_status, internet_message_id, dedup_key)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)
     ON CONFLICT (automation_id, dedup_key) DO UPDATE SET
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
      dedup.internet_message_id,
      dedup.dedup_key,
    ],
    { expectRows: 1 },
  );

  const artifactRow = upsert.rows[0];
  const artifactId = artifactRow.id;

  // Duplicate-and-already-processed: no-op at every downstream layer.
  // Emit a typed dedup event so the learning loop can see how often
  // each automation runs into idempotent re-polls (high rates indicate
  // either an over-eager cron schedule or a cursor that isn't advancing).
  if (!artifactRow.inserted && artifactRow.parse_status === "processed") {
    trackEvent("automations.artifact_deduplicated", req.user_id, req.user_role, {
      automation_id: automationId,
      source_type: req.source_type,
      source_message_id: req.source_message_id ?? "",
      dedup_strategy: dedup.strategy,
    });
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
    class_override: req.class_override,
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
    // Multi-class survey fallback: when the survey parser refuses
    // because the filename names two courses (e.g. "101 Intercontinental
    // & 102 Conrad"), try to auto-split using the daily roster instead
    // of quarantining. This is the auto-splitter path — see
    // splitMixedSurvey for the join semantics. If we can't find
    // candidate classes, we fall through to the original quarantine
    // behavior so the artifact still surfaces in the exception queue.
    if (
      req.source_type === "survey" &&
      result.exception_kind === "parse_failure" &&
      /multiple (courses|locations)/i.test(result.error)
    ) {
      const splitSnapshots = await tryAutoSplitSurvey({
        bytes: req.bytes,
        hint: req.hint,
        receivedAt: req.received_at,
        sourceMessageId: req.source_message_id,
        sourceArtifactId: artifactId,
      });
      if (splitSnapshots && splitSnapshots.length > 0) {
        // Persist the split snapshots through the normal pipeline so
        // deltas + analytics fire just like the single-class path.
        let snapshotsWritten = 0;
        let deltasWritten = 0;
        const auditSnapshotIds: string[] = [];
        for (const snap of splitSnapshots) {
          const written = await persistSnapshot(automationId, snap);
          if (written.created) {
            snapshotsWritten += 1;
            auditSnapshotIds.push(written.snapshot_id);
          }
          if (written.delta_id) {
            deltasWritten += 1;
            trackEvent(
              "automations.delta_computed",
              req.user_id,
              req.user_role,
              {
                automation_id: automationId,
                class_key: written.class_key,
                added: written.added,
                dropped: written.dropped,
                is_baseline: written.is_baseline,
              },
            );
          }
          // Notify on summary-ready transition for each affected class.
          await notifySummaryReadyIfTransition({
            automation_id: automationId,
            class_key: written.class_key,
          }).catch(() => {});
        }
        await writeQuery(
          `UPDATE instinct_automation_porsche_artifacts
              SET parse_status = 'processed'
            WHERE id = $1
            RETURNING id`,
          [artifactId],
          { expectRows: 1 },
        );
        trackEvent(
          "automations.artifact_ingested",
          req.user_id,
          req.user_role,
          {
            automation_id: automationId,
            source_type: req.source_type,
            source_message_id: req.source_message_id ?? "",
            classes: snapshotsWritten,
            // Distinguishes auto-split events from straight-through
            // ingests in analytics — useful both for measuring how
            // often the splitter is invoked and for the dashboard's
            // "needs attention" surface.
            auto_split: true,
          },
        );
        // Audit log + 24h undo: the auto-split is a SYSTEM-driven mutation
        // that the operator may want to reverse if the splitter routed
        // responses to the wrong classes. Capture the synthetic snapshot
        // ids + the parser's original error so the revert handler can
        // delete the snapshots AND restore a fresh parse_failure
        // exception. Actor is "system" — no user clicked, the orchestrator
        // ran from the inbox poller path. Defensive try/catch so an audit
        // outage does not poison the artifact-processed state.
        if (auditSnapshotIds.length > 0) {
          try {
            await recordAction({
              automation_id: automationId,
              action_kind: "survey_auto_split",
              target_ref: artifactId,
              actor: "system",
              detail: {
                snapshot_ids: auditSnapshotIds,
                exception_id: null,
                original_error: result.error,
              },
            });
          } catch (err) {
            console.warn(
              `[ingest] audit insert (survey_auto_split) failed: ${(err as Error).message}`,
            );
          }
        }
        return {
          artifact_id: artifactId,
          was_duplicate: false,
          parse_status: "processed",
          snapshots_written: snapshotsWritten,
          deltas_written: deltasWritten,
        };
      }
      // Fallthrough: no candidates found — quarantine with a more
      // helpful error so the operator knows the auto-split path was
      // attempted but the daily roster wasn't available.
      return await quarantine({
        artifactId,
        automationId,
        source_message_id: req.source_message_id,
        reason: `${result.error} (auto-split attempted: no roster snapshots found for the courses + dates in the filename)`,
        exceptionKind: result.exception_kind,
        user_id: req.user_id,
        user_role: req.user_role,
        finalStatus: "error_quarantined",
      });
    }

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
    // Notify operators when this snapshot drives the class to "ready"
    // (all four sources present for the first time). Fire-and-forget —
    // failures don't poison the ingest write path.
    await notifySummaryReadyIfTransition({
      automation_id: automationId,
      class_key: written.class_key,
    }).catch(() => {});
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
/* Multi-class survey auto-split helper                                */
/* ------------------------------------------------------------------ */

interface AutoSplitArgs {
  bytes: Buffer;
  hint: string;
  receivedAt: string;
  sourceMessageId: string | null;
  sourceArtifactId: string;
}

/**
 * Attempt to auto-split a survey export that mixes responses from
 * multiple classes. Returns null when:
 *   - filename can't be parsed for course tokens / date range
 *   - survey bytes can't be decoded
 *   - no roster snapshots match the inferred courses + date window
 *
 * On success, returns the SnapshotInputs from `splitMixedSurvey` ready
 * for `persistSnapshot`. Date tolerance is ±3 days vs. the start/end
 * range parsed from the filename — covers off-by-one weekend dates and
 * misaligned date pickers without pulling in unrelated classes.
 */
async function tryAutoSplitSurvey(
  args: AutoSplitArgs,
): Promise<ReturnType<typeof splitMixedSurvey> | null> {
  const fallbackYear =
    Number(args.receivedAt.slice(0, 4)) || new Date().getFullYear();
  const filenameParts = parseMultiClassFilename(args.hint, fallbackYear);
  if (!filenameParts) return null;

  // Decode rows BEFORE the DB query — if the bytes are malformed we
  // shouldn't waste a query on candidates we'll never use.
  const decoded = decodeSurveyRows(args.bytes);
  if ("error" in decoded) return null;

  // Fetch candidate roster snapshots: matching course types, date
  // within ±3 days of the filename's date range. We pull the LATEST
  // snapshot per class_key so a re-uploaded daily report doesn't
  // create phantom candidates.
  const TOLERANCE_DAYS = 3;
  const startDate = shiftIsoDate(filenameParts.date_start, -TOLERANCE_DAYS);
  const endDate = shiftIsoDate(filenameParts.date_end, TOLERANCE_DAYS);

  const candidatesRes = await query<{
    class_key: string;
    course_type: CourseType;
    class_date: string;
    location: string;
    source_payload: { participants_with_ppn?: Array<{ ppn_id: string | null }> } | null;
  }>(
    `SELECT DISTINCT ON (class_key)
            class_key, course_type, class_date::text AS class_date,
            location, source_payload
       FROM instinct_automation_porsche_snapshots
      WHERE source_type = 'porsche_xlsx'
        AND course_type = ANY($1::text[])
        AND class_date >= $2::date
        AND class_date <= $3::date
      ORDER BY class_key, captured_at DESC, created_at DESC`,
    [filenameParts.course_types, startDate, endDate],
  );

  if (candidatesRes.rows.length === 0) return null;

  const candidateClasses: CandidateClass[] = candidatesRes.rows.map((r) => {
    const ppns = new Set<string>();
    const list = r.source_payload?.participants_with_ppn ?? [];
    for (const p of list) {
      if (p.ppn_id) ppns.add(p.ppn_id.toLowerCase());
    }
    return {
      course_type: r.course_type,
      class_date: r.class_date,
      location: r.location,
      roster_ppns: ppns,
    };
  });

  // If NO candidate has any PPN IDs at all, the auto-split would be a
  // no-op — fall through to quarantine with a distinct error so we
  // know to backfill the rosters with PPN IDs before retrying.
  const totalPpnsAcross = candidateClasses.reduce(
    (n, c) => n + c.roster_ppns.size,
    0,
  );
  if (totalPpnsAcross === 0) return null;

  return splitMixedSurvey({
    rows: decoded.rows,
    filename: args.hint,
    receivedAt: args.receivedAt,
    sourceMessageId: args.sourceMessageId,
    sourceArtifactId: args.sourceArtifactId,
    candidateClasses,
  });
}

/** Shift an ISO date `YYYY-MM-DD` by N days. Pure UTC arithmetic — no
 *  local-tz drift.  */
function shiftIsoDate(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86400000;
  const out = new Date(t);
  const yy = out.getUTCFullYear();
  const mm = String(out.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(out.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
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

  /* parse_failure deserves a dedicated event so the learning loop can
     surface "this CWE-style column-rename keeps biting us" without
     digging through the generic quarantined stream. The reason string
     is the same one persisted on the exception row — operators see
     identical text in both views. */
  if (args.exceptionKind === "parse_failure") {
    trackEvent("automations.parse_failure", args.user_id, args.user_role, {
      automation_id: args.automationId,
      source_message_id: args.source_message_id ?? "",
      reason: args.reason,
    });
  }

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
