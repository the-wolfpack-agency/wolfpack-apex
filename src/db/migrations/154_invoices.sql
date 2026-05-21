-- Migration 154 — AP invoice queue.
--
-- Backs the /finance/invoices page + the ScanInvoiceWidget. Each row
-- is one vendor invoice scanned via Azure Document Intelligence
-- (prebuilt-invoice). Lifecycle:
--   pending  → uploaded + extracted, awaiting human review
--   approved → reviewed + ok to pay
--   paid     → marked paid in the queue (audit trail; integration
--              with a real AP system is a future feature)
--   rejected → flagged as bad / duplicate / wrong vendor
--
-- raw_bytes_sha256 + (workspace_id) dedups uploads — same invoice
-- twice never burns a second Form Recognizer transaction.
--
-- `extracted_fields` keeps the full Azure response so the UI can
-- surface anything the prebuilt-invoice model returned beyond the
-- columns we promote to first-class fields. `applied_*` columns
-- track what the human committed vs what the model extracted —
-- feeds the OCR-vs-human drift signal on the learning loop.

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_invoices (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL,
  uploaded_by           UUID NOT NULL,
  uploaded_by_email     TEXT,
  uploaded_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw_bytes_sha256      TEXT NOT NULL,
  original_filename     TEXT,
  content_type          TEXT,
  size_bytes            INT NOT NULL,
  /* Promoted-to-column extracted values — overridable by humans via
     PATCH /api/finance/invoices/[id]. NULLable because Form
     Recognizer doesn't always find every field. */
  vendor_name           TEXT,
  invoice_number        TEXT,
  invoice_date          DATE,
  due_date              DATE,
  subtotal              NUMERIC(14, 2),
  tax                   NUMERIC(14, 2),
  total                 NUMERIC(14, 2),
  currency              TEXT,
  line_items            JSONB NOT NULL DEFAULT '[]'::jsonb,
  /* Full Azure response — preserved so the UI can surface anything
     prebuilt-invoice returned. */
  extracted_fields      JSONB NOT NULL,
  /* AP workflow state. */
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'approved', 'paid', 'rejected')),
  approved_by           UUID,
  approved_by_email     TEXT,
  approved_at           TIMESTAMPTZ,
  paid_at               TIMESTAMPTZ,
  rejected_reason       TEXT,
  notes                 TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  /* Optional FK to a job code for cost-allocation reporting. NULL
     until the user assigns it. */
  assigned_job_code     TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_instinct_invoices_sha
  ON instinct_invoices (workspace_id, raw_bytes_sha256);
CREATE INDEX IF NOT EXISTS ix_instinct_invoices_status
  ON instinct_invoices (workspace_id, status, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS ix_instinct_invoices_vendor
  ON instinct_invoices (workspace_id, vendor_name) WHERE vendor_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_instinct_invoices_due
  ON instinct_invoices (workspace_id, due_date) WHERE due_date IS NOT NULL AND status IN ('pending', 'approved');

COMMIT;
