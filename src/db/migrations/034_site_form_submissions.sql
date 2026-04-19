-- 034_site_form_submissions.sql — PUBLIC contact-form submissions for Instinct Sites.
--
-- A deployed wolfpack-{slug}.vercel.app site (or any verified custom
-- domain from migration 033) POSTs to
--   https://wolfpack-instinct.vercel.app/api/public/forms/{siteId}/submit
-- This table is the audit + learning-loop record of every submission
-- attempt, including rejected ones (origin_not_allowed, rate_limited,
-- honeypot_tripped) so the brain sees attack patterns and real traffic
-- side by side.
--
-- NO raw IPs stored — `ip_hash` is SHA256(ip + INSTINCT_IP_HASH_SALT).
-- Privacy-first: even the admin UI never sees who submitted from where,
-- only collision buckets for rate limiting.
--
-- NOTE: `site_id` is TEXT to match `apex_site_projects.id` (TEXT,
-- shape `site_<uuid>`), matching the convention in 009/029/031/032/033.

CREATE TABLE IF NOT EXISTS apex_site_form_submissions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id           TEXT NOT NULL,
  payload           JSONB NOT NULL,                     -- sanitized field values
  origin            TEXT NOT NULL,                      -- host that submitted
  ip_hash           TEXT NOT NULL,                      -- SHA256(ip + salt)
  user_agent        TEXT,
  recipient_email   TEXT,                               -- snapshot at submit time
  email_status      TEXT NOT NULL DEFAULT 'pending',    -- pending | sent | failed | throttled
  email_error       TEXT,
  spam_score        INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT apex_site_form_submissions_site_fk
    FOREIGN KEY (site_id) REFERENCES apex_site_projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS apex_site_form_submissions_site_idx
  ON apex_site_form_submissions(site_id);
CREATE INDEX IF NOT EXISTS apex_site_form_submissions_created_idx
  ON apex_site_form_submissions(created_at DESC);
CREATE INDEX IF NOT EXISTS apex_site_form_submissions_email_status_idx
  ON apex_site_form_submissions(email_status);

-- Instinct-name alias, mirroring 014/033's convention so external readers
-- can query `instinct_site_form_submissions` without knowing about the
-- apex_ legacy prefix.
CREATE OR REPLACE VIEW instinct_site_form_submissions AS
  SELECT * FROM apex_site_form_submissions;
