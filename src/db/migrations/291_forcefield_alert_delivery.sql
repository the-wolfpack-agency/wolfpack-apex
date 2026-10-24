-- Forcefield alerts: windowed dedupe + a recorded delivery outcome.
--
-- Migration 270 deduped on (alert_kind, fingerprint) with no time window, and
-- the fingerprint was built from (kind, fp, site) where fp is 'unknown' for
-- almost every event. One row per site per kind therefore suppressed every
-- later alert forever. The scanner now builds the fingerprint from
-- (kind, site, attack class, 6-hour window start), so the existing unique key
-- holds per incident and window. These columns record what happened to each
-- alert so a failed send is visible (and retried) instead of swallowed, and so
-- the daily silence check can count alerts that actually reached a person.
--
-- Safe on live data: additive, nullable or defaulted columns only. Existing
-- rows keep delivery_status NULL (outcome was never recorded). Idempotent.

ALTER TABLE instinct_forcefield_web_alerts
  ADD COLUMN IF NOT EXISTS site TEXT,
  ADD COLUMN IF NOT EXISTS attack_class TEXT,
  ADD COLUMN IF NOT EXISTS window_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivery_status TEXT,
  ADD COLUMN IF NOT EXISTS delivery_detail TEXT,
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_ff_web_alerts_delivered
  ON instinct_forcefield_web_alerts (delivery_status, dispatched_at);
