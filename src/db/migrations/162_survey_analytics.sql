-- 162_survey_analytics.sql
--
-- Survey data collection / funnel. Matches what a form SaaS gives
-- (per-response data) and adds what it can't: the view→completion funnel
-- and per-response attribution (device/geo/referrer + QR-scan link), so
-- the learning loop can compute completion rate, time-to-complete, and
-- channel performance.
--
-- instinct_survey_views: one row per public responder load. Paired with
-- responses, this yields views, completion rate, and drop-off.
-- Response columns: duration_ms (time-on-form) + device/geo/referrer.
--
-- Idempotent: CREATE/ADD ... IF NOT EXISTS. Additive only.

CREATE TABLE IF NOT EXISTS instinct_survey_views (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id               UUID NOT NULL REFERENCES instinct_surveys(id) ON DELETE CASCADE,
  viewed_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  respondent_fingerprint  TEXT,
  device                  TEXT,
  country                 TEXT,
  referrer                TEXT,
  qr_scan_id              UUID
);

CREATE INDEX IF NOT EXISTS idx_survey_views_survey
  ON instinct_survey_views (survey_id, viewed_at DESC);

ALTER TABLE instinct_survey_responses
  ADD COLUMN IF NOT EXISTS duration_ms INTEGER;
ALTER TABLE instinct_survey_responses
  ADD COLUMN IF NOT EXISTS device TEXT;
ALTER TABLE instinct_survey_responses
  ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE instinct_survey_responses
  ADD COLUMN IF NOT EXISTS referrer TEXT;
