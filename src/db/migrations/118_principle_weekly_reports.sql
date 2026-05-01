-- 118_principle_weekly_reports.sql — stored weekly summaries from
-- the principles cron. Read by /api/principles/reports/latest +
-- rendered on the /principles team tab.
--
-- One row per (week_start, generated_at). The cron upserts on
-- (week_start) so re-running for the same week replaces the row.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS instinct_principle_weekly_reports (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start        DATE NOT NULL UNIQUE,
  week_end          DATE NOT NULL,
  markdown_body     TEXT NOT NULL DEFAULT '',
  observation_count INTEGER NOT NULL DEFAULT 0,
  principle_count   INTEGER NOT NULL DEFAULT 0,
  generated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_principle_weekly_reports_generated
  ON instinct_principle_weekly_reports (generated_at DESC);

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'instinct_principle_weekly_reports'
       AND column_name IN ('id','week_start','week_end','markdown_body','observation_count','principle_count','generated_at')
  ) = 7, 'instinct_principle_weekly_reports missing expected columns';
END $$;

COMMIT;
