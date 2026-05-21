-- Migration 155 — HR scanned documents store.
--
-- Each row is one HR doc uploaded for an employee: ID (license,
-- passport), W-2 / W-9 / W-4 / I-9, voided check, or "other".
-- Form Recognizer has prebuilt models for SOME types (idDocument,
-- tax.us.w2); others land as Computer Vision OCR text in
-- extracted_text. doc_type drives which model the route picks.
--
-- Tied to instinct_team_members.id when the employee is in
-- Instinct. employee_email allows uploading for contractors who
-- aren't yet team members.

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_hr_scanned_documents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL,
  uploaded_by       UUID NOT NULL,
  uploaded_by_email TEXT,
  uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw_bytes_sha256  TEXT NOT NULL,
  original_filename TEXT,
  content_type      TEXT,
  size_bytes        INT NOT NULL,
  /* Employee this doc belongs to. team_member_id when they have an
     Instinct account; employee_email always set (the canonical
     identity). employee_name is the display name as-uploaded. */
  team_member_id    UUID,
  employee_email    TEXT NOT NULL,
  employee_name     TEXT,
  /* Doc type the user picked at upload time. Drives extractor
     selection (idDocument -> prebuilt-idDocument, w2 ->
     prebuilt-tax.us.w2, others -> Computer Vision OCR). */
  doc_type          TEXT NOT NULL CHECK (doc_type IN (
    'license', 'passport', 'state_id',
    'w2', 'w4', 'w9', 'i9',
    'voided_check', 'direct_deposit', 'other'
  )),
  /* Promoted fields when prebuilt-idDocument or tax models run. */
  document_number   TEXT,
  document_expiry   DATE,
  full_name         TEXT,
  /* Full extracted payload (structured fields when available; OCR
     text in `text` field when fallback ran). */
  extracted_fields  JSONB NOT NULL DEFAULT '{}'::jsonb,
  extracted_text    TEXT,
  /* Optional admin notes — used to flag missing pages, expired IDs,
     compliance verification status. */
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected', 'expired')),
  verified_by       UUID,
  verified_at       TIMESTAMPTZ,
  rejected_reason   TEXT,
  notes             TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_instinct_hr_scanned_documents_sha
  ON instinct_hr_scanned_documents (workspace_id, raw_bytes_sha256);
CREATE INDEX IF NOT EXISTS ix_instinct_hr_scanned_documents_employee
  ON instinct_hr_scanned_documents (workspace_id, employee_email, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS ix_instinct_hr_scanned_documents_status
  ON instinct_hr_scanned_documents (workspace_id, status, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS ix_instinct_hr_scanned_documents_expiry
  ON instinct_hr_scanned_documents (document_expiry) WHERE document_expiry IS NOT NULL AND status = 'verified';

COMMIT;
