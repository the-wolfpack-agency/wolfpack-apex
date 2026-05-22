/**
 * Document recognition persistence layer.
 *
 * Writes go through writeQuery so a silent drop is impossible — the
 * recognition row is the source of truth for the learning loop and a
 * missing row means a lost training signal. Reads go through query and
 * tolerate empty result sets cleanly.
 *
 * Schema: see src/db/migrations/158_document_recognitions.sql. This
 * file maps the DB row <-> the shared RecognizedDocument shape from
 * @/lib/document-recognition/types.
 *
 * Workspace scoping: every read and write filters by workspace_id.
 * Cross-tenant access is structurally impossible from these helpers.
 */

import { query, writeQuery } from "@/lib/db";
import {
  type DocumentClassification,
  type DocumentType,
  type ExtractedDocument,
  type ExtractorKey,
  type RecognizedDocument,
  DOCUMENT_TYPES,
} from "@/lib/document-recognition/types";

/* ------------------------------ DB shapes ------------------------------ */

/** Internal: the row shape we read out of instinct_document_recognitions. */
interface RecognitionRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  uploaded_by: string;
  uploaded_at: string;
  source_filename: string | null;
  source_mime: string;
  source_bytes: number;
  source_sha256: string;
  classified_type: DocumentType;
  classification_confidence: string | number;
  classification_alternates: unknown;
  classification_rationale: string | null;
  classifier_model: string;
  classifier_latency_ms: number;
  classifier_cost_cents: string | number;
  extractor_key: ExtractorKey | null;
  extractor_model: string | null;
  extracted_fields: unknown;
  extracted_raw_text: string | null;
  extractor_latency_ms: number | null;
  extractor_cost_cents: string | number | null;
  pii_blocked: boolean;
  error_kind: string | null;
  error_message: string | null;
  user_corrected_type: DocumentType | null;
  user_corrected_at: string | null;
}

function toNumber(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === "number" ? v : Number(v);
}

function parseJsonField<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
}

/* ----------------------------- Row mapper ------------------------------ */

/**
 * Map a DB row to the shared RecognizedDocument shape. Extraction is
 * null when extractor_key is null or extracted_fields is empty — both
 * legitimate "no extractor ran" signals (unknown type, pii_blocked,
 * extractor failure).
 */
export function rowToRecognizedDocument(row: RecognitionRow): RecognizedDocument {
  const classification: DocumentClassification = {
    type: row.classified_type,
    confidence: toNumber(row.classification_confidence),
    alternates: parseJsonField(row.classification_alternates, []) as DocumentClassification["alternates"],
    rationale: row.classification_rationale ?? "",
    model: row.classifier_model,
    latencyMs: row.classifier_latency_ms,
    costCents: toNumber(row.classifier_cost_cents),
  };

  let extraction: ExtractedDocument | null = null;
  if (row.extractor_key && row.extractor_key !== "none") {
    const fields = parseJsonField(row.extracted_fields, null) as ExtractedDocument["fields"] | null;
    if (fields !== null) {
      extraction = {
        extractor: row.extractor_key,
        model: row.extractor_model ?? "",
        fields,
        rawText: row.extracted_raw_text ?? "",
        latencyMs: row.extractor_latency_ms ?? 0,
        costCents: toNumber(row.extractor_cost_cents),
      };
    }
  }

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.uploaded_by,
    sourceFile: {
      filename: row.source_filename ?? "",
      mime: row.source_mime,
      bytes: row.source_bytes,
      sha256: row.source_sha256,
    },
    classification,
    extraction,
    piiBlocked: row.pii_blocked,
    recognizedAt: row.uploaded_at,
  };
}

/* ------------------------------ Inserts -------------------------------- */

export interface InsertRecognitionArgs {
  workspaceId: string;
  uploadedBy: string;
  source: { filename: string; mime: string; bytes: number; sha256: string };
  classification: DocumentClassification;
  extraction: ExtractedDocument | null;
  piiBlocked: boolean;
  errorKind?: string;
  errorMessage?: string;
}

/**
 * Insert a recognition row. Returns the new id. Every pipeline outcome
 * (success, pii_blocked, classifier failure, extractor failure) goes
 * through here — no data lost, per CLAUDE.md.
 */
export async function insertRecognition(
  args: InsertRecognitionArgs,
): Promise<{ id: string }> {
  const ex = args.extraction;
  const res = await writeQuery<{ id: string }>(
    `INSERT INTO instinct_document_recognitions
       (workspace_id, uploaded_by,
        source_filename, source_mime, source_bytes, source_sha256,
        classified_type, classification_confidence, classification_alternates,
        classification_rationale, classifier_model, classifier_latency_ms,
        classifier_cost_cents,
        extractor_key, extractor_model, extracted_fields, extracted_raw_text,
        extractor_latency_ms, extractor_cost_cents,
        pii_blocked, error_kind, error_message)
     VALUES ($1, $2,
             $3, $4, $5, $6,
             $7, $8, $9::jsonb,
             $10, $11, $12,
             $13,
             $14, $15, $16::jsonb, $17,
             $18, $19,
             $20, $21, $22)
     RETURNING id`,
    [
      args.workspaceId,
      args.uploadedBy,
      args.source.filename || null,
      args.source.mime,
      args.source.bytes,
      args.source.sha256,
      args.classification.type,
      args.classification.confidence,
      JSON.stringify(args.classification.alternates ?? []),
      args.classification.rationale || null,
      args.classification.model,
      args.classification.latencyMs,
      args.classification.costCents,
      ex ? ex.extractor : null,
      ex ? ex.model : null,
      ex ? JSON.stringify(ex.fields) : null,
      ex ? ex.rawText : null,
      ex ? ex.latencyMs : null,
      ex ? ex.costCents : null,
      args.piiBlocked,
      args.errorKind ?? null,
      args.errorMessage ?? null,
    ],
    { expectRows: 1 },
  );
  return { id: res.rows[0].id };
}

/* -------------------------------- Reads -------------------------------- */

/** SELECT * style read for a single recognition, scoped to workspace. */
export async function getRecognition(
  workspaceId: string,
  id: string,
): Promise<RecognizedDocument | null> {
  const res = await query<RecognitionRow>(
    `SELECT * FROM instinct_document_recognitions
     WHERE workspace_id = $1 AND id = $2
     LIMIT 1`,
    [workspaceId, id],
  );
  const row = res.rows[0];
  return row ? rowToRecognizedDocument(row) : null;
}

/**
 * Dedup helper: returns the most recent recognition in this workspace
 * for the given source SHA, IF it falls within the lookback window.
 * Used by the POST handler to avoid re-running the pipeline (and re-
 * paying the vendor cost) on the same bytes from the same workspace.
 *
 * Lookback in hours, not days, because correction loops + re-classifies
 * should re-run after the day window.
 */
export async function findRecentBySha(
  workspaceId: string,
  sha256: string,
  withinHours: number,
): Promise<RecognizedDocument | null> {
  const res = await query<RecognitionRow>(
    `SELECT * FROM instinct_document_recognitions
     WHERE workspace_id = $1 AND source_sha256 = $2
       AND uploaded_at > NOW() - INTERVAL '1 hour' * $3
     ORDER BY uploaded_at DESC
     LIMIT 1`,
    [workspaceId, sha256, withinHours],
  );
  const row = res.rows[0];
  return row ? rowToRecognizedDocument(row) : null;
}

/* ----------------------------- Corrections ----------------------------- */

export interface RecordUserCorrectionArgs {
  workspaceId: string;
  id: string;
  correctedType: DocumentType;
}

/**
 * Apply a user correction (the user told us the classifier got the
 * type wrong). Sets user_corrected_type + user_corrected_at = NOW().
 * Returns the updated row mapped to RecognizedDocument shape, or null
 * if the recognition isn't in this workspace (404 path).
 */
export async function recordUserCorrection(
  args: RecordUserCorrectionArgs,
): Promise<RecognizedDocument | null> {
  /* Validate at the boundary so a typo in the caller doesn't bypass
     the DB check (which would surface as a 22000-class pg error). */
  if (!DOCUMENT_TYPES.includes(args.correctedType)) {
    return null;
  }
  const res = await writeQuery<RecognitionRow>(
    `UPDATE instinct_document_recognitions
     SET user_corrected_type = $3,
         user_corrected_at = NOW()
     WHERE workspace_id = $1 AND id = $2
     RETURNING *`,
    [args.workspaceId, args.id, args.correctedType],
  );
  const row = res.rows[0];
  return row ? rowToRecognizedDocument(row) : null;
}
