-- Dedupe store for Forcefield-web hostile-signal alerts. One row per distinct
-- (alert_kind, fingerprint); a recurring scan that re-observes the same signal is
-- a no-op INSERT (ON CONFLICT DO NOTHING), so we alert once per genuinely new
-- hostile fingerprint rather than every scan.
CREATE TABLE IF NOT EXISTS instinct_forcefield_web_alerts (
  id           TEXT PRIMARY KEY,
  alert_kind   TEXT NOT NULL,
  fingerprint  TEXT NOT NULL,
  severity     TEXT NOT NULL DEFAULT 'high',
  title        TEXT NOT NULL,
  body         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (alert_kind, fingerprint)
);
