-- 161_surveys.sql
--
-- Client-facing survey builder. A survey is an owned, in-house form
-- (no third-party SaaS): a JSON schema of questions + a public responder
-- at /s/<slug>. Responses are first-class Instinct data — stored here in
-- Postgres (source of truth), emitted as analytics events, and joinable
-- to clients / QR scans / the learning loop. Optionally linked to a QR
-- code (instinct_qr_codes) so a printed scan flows scan → survey →
-- response → learning.
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS. Additive only.

CREATE TABLE IF NOT EXISTS instinct_surveys (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                 TEXT NOT NULL UNIQUE,
  title                TEXT NOT NULL,
  description          TEXT,
  -- { questions: [{ id, type, label, required, options?, max? }] }
  schema               JSONB NOT NULL DEFAULT '{"questions":[]}'::jsonb,
  status               TEXT NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft', 'published', 'closed')),
  -- Optional link to the QR code that points at this survey.
  qr_code_id           UUID,
  client_id            UUID,
  created_by_user_id   TEXT,
  created_by_user_role TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_surveys_slug_published
  ON instinct_surveys (slug)
  WHERE status = 'published';
CREATE INDEX IF NOT EXISTS idx_surveys_owner
  ON instinct_surveys (created_by_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS instinct_survey_responses (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id               UUID NOT NULL REFERENCES instinct_surveys(id) ON DELETE CASCADE,
  -- { [questionId]: string | string[] | number }
  answers                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Coarse ip+ua hash for dedup / abuse — never the raw IP.
  respondent_fingerprint  TEXT,
  -- Optional attribution: the QR scan that led here.
  qr_scan_id              UUID,
  submitted_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_survey_responses_survey
  ON instinct_survey_responses (survey_id, submitted_at DESC);
