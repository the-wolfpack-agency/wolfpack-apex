-- 011_hr_documents.sql — Unified HR documents store.
--
-- Single system of record for every HR document Alicia uploads.
-- Specialized tabs (Benefits, future Payroll/Compliance) are LENSES
-- over this table — they filter by category. The file is never
-- duplicated; one row, multiple views.
--
-- Closed-loop: every upload, classification, recategorization, and
-- employee link emits a tracked event so the brain learns Alicia's
-- workflow.

CREATE TABLE IF NOT EXISTS apex_hr_documents (
  id              TEXT PRIMARY KEY,
  filename        TEXT NOT NULL,
  mime_type       TEXT,
  size_bytes      INTEGER NOT NULL,
  page_count      INTEGER,
  -- Smart-routed category. v1 values:
  --   w4 | i9 | benefits_renewal | offer_letter | handbook | unclassified
  category        TEXT NOT NULL DEFAULT 'unclassified',
  classification_confidence NUMERIC,
  classification_reasons JSONB DEFAULT '[]'::jsonb,
  -- Optional employee link (set when Alicia files against a person)
  employee_id     TEXT REFERENCES apex_employees(id) ON DELETE SET NULL,
  -- Optional cross-link to apex_benefit_documents when category =
  -- benefits_renewal — keeps one source of truth across tabs.
  benefit_document_id TEXT REFERENCES apex_benefit_documents(id) ON DELETE SET NULL,
  raw_text_excerpt TEXT,
  -- Lifecycle fields for the future Documents detail view
  signed_at       TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'active',  -- active|archived|expired
  uploaded_by     TEXT NOT NULL,
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_apex_hr_documents_category ON apex_hr_documents(category);
CREATE INDEX IF NOT EXISTS idx_apex_hr_documents_employee ON apex_hr_documents(employee_id);
CREATE INDEX IF NOT EXISTS idx_apex_hr_documents_uploaded ON apex_hr_documents(uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_apex_hr_documents_expires ON apex_hr_documents(expires_at) WHERE expires_at IS NOT NULL;
