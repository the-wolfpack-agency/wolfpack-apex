-- Migration 153 — persisted receipt-scan extractions.
--
-- Each row is one Form Recognizer extraction the user might choose to
-- apply against a job code's Program / PO Number / PO Amount. We keep
-- them around even after "apply" so:
--   1. The user can re-review what the model returned vs. what they
--      entered (drift between OCR and manual = learning signal).
--   2. If the apply step fails, the extraction isn't lost — the user
--      can try a different code or retry the apply.
--   3. Future feature: auto-suggest the right code based on merchant
--      → category mapping (needs historical data to train against).
--
-- raw_bytes_sha256 is the dedup key. Uploading the same receipt twice
-- collapses to the same row; we don't pay Form Recognizer a second
-- transaction for it.

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_receipt_scans (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL,
  uploaded_by       UUID NOT NULL,
  uploaded_by_email TEXT,
  uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw_bytes_sha256  TEXT NOT NULL,
  original_filename TEXT,
  content_type      TEXT,
  size_bytes        INT NOT NULL,
  /* fields = the full Form Recognizer response shape we surface to
     the UI (MerchantName, TransactionDate, Total, Items[], ...). Stored
     as JSONB so future field additions don't require a schema change. */
  fields            JSONB NOT NULL,
  /* applied_to_code is set when the user clicks "Apply to job code"
     in the UI — at which point we PATCH the SharePoint cell(s) via
     the existing /api/job-codes/[code]/cell route. NULL = extracted
     but not yet applied. */
  applied_to_code   TEXT,
  applied_at        TIMESTAMPTZ,
  /* applied_program / applied_po_number / applied_po_amount track the
     EXACT values the user committed. Lets us compute the drift
     between OCR and what the human typed — feeds the learning loop. */
  applied_program   TEXT,
  applied_po_number TEXT,
  applied_po_amount TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_instinct_receipt_scans_sha
  ON instinct_receipt_scans (workspace_id, raw_bytes_sha256);
CREATE INDEX IF NOT EXISTS ix_instinct_receipt_scans_user
  ON instinct_receipt_scans (uploaded_by, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS ix_instinct_receipt_scans_code
  ON instinct_receipt_scans (applied_to_code) WHERE applied_to_code IS NOT NULL;

COMMIT;
