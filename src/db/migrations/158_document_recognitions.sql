-- Migration 158 — Document recognition pipeline persistence.
--
-- Captures every run of the recognition pipeline (classifier + extractor)
-- so the learning loop can analyze classification accuracy, extractor
-- accuracy by type, and user corrections over time.
--
-- One row per file upload regardless of outcome (classifier failed,
-- extractor failed, pii_blocked, success). No data lost — even failed
-- runs feed the analytics layer per the global CLAUDE.md directive.

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_document_recognitions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        TEXT NOT NULL,
  uploaded_by         UUID NOT NULL,
  uploaded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  /* Source file. */
  source_filename     TEXT,
  source_mime         TEXT NOT NULL,
  source_bytes        INT NOT NULL,
  source_sha256       TEXT NOT NULL,

  /* Classifier output. */
  classified_type     TEXT NOT NULL CHECK (classified_type IN (
    'receipt', 'invoice', 'tax_w2', 'tax_1099', 'id_document', 'unknown'
  )),
  classification_confidence NUMERIC(4,3) NOT NULL CHECK (
    classification_confidence >= 0 AND classification_confidence <= 1
  ),
  classification_alternates JSONB NOT NULL DEFAULT '[]'::jsonb,
  classification_rationale TEXT,
  classifier_model    TEXT NOT NULL,
  classifier_latency_ms INT NOT NULL,
  classifier_cost_cents NUMERIC(8,4) NOT NULL DEFAULT 0,

  /* Extractor output. null when extractor not run (unknown type, pii_blocked, or failure). */
  extractor_key       TEXT,
  extractor_model     TEXT,
  extracted_fields    JSONB,
  extracted_raw_text  TEXT,
  extractor_latency_ms INT,
  extractor_cost_cents NUMERIC(8,4),

  /* Pipeline outcome. */
  pii_blocked         BOOLEAN NOT NULL DEFAULT FALSE,
  error_kind          TEXT,
  error_message       TEXT,

  /* User correction signal — when set, the user reclassified the
     document. Drives the learning loop. */
  user_corrected_type TEXT CHECK (user_corrected_type IS NULL OR user_corrected_type IN (
    'receipt', 'invoice', 'tax_w2', 'tax_1099', 'id_document', 'unknown'
  )),
  user_corrected_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS instinct_document_recognitions_workspace_idx
  ON instinct_document_recognitions (workspace_id);

CREATE INDEX IF NOT EXISTS instinct_document_recognitions_uploaded_at_idx
  ON instinct_document_recognitions (workspace_id, uploaded_at DESC);

CREATE INDEX IF NOT EXISTS instinct_document_recognitions_classified_type_idx
  ON instinct_document_recognitions (workspace_id, classified_type);

/* Dedup helper: same workspace + same source bytes = same upload.
   Not a unique constraint because legitimate re-classifications happen. */
CREATE INDEX IF NOT EXISTS instinct_document_recognitions_sha256_idx
  ON instinct_document_recognitions (workspace_id, source_sha256);

COMMIT;
