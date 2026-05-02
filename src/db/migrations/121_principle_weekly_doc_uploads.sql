-- 121_principle_weekly_doc_uploads.sql — audit log for the weekly-report
-- SharePoint write-back leg. The weekly cron (118) builds + persists
-- the markdown report; this table records every attempt to PUT the
-- generated .docx into the same SharePoint folder as the source
-- principles doc, regardless of outcome.
--
-- One row per attempt (NOT upserted on week_start) so we keep the
-- forensic history when the cron retries after a transient Graph
-- failure. The `status` column distinguishes 'uploaded',
-- 'skipped' (no config / not connected / scope_missing), and
-- 'failed' (graph error / network / parse).
--
-- Read by:
--   - /principles team-tab UI (last upload status banner)
--   - learning loop: success/failure trends per attempted_by user

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS instinct_principle_weekly_doc_uploads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start      DATE NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('uploaded','skipped','failed')),
  reason_code     TEXT,
  filename        TEXT,
  byte_count      INTEGER,
  parent_drive_id TEXT,
  parent_item_id  TEXT,
  web_url         TEXT,
  etag            TEXT,
  attempted_by    TEXT,
  error_message   TEXT,
  attempted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_principle_weekly_doc_uploads_week
  ON instinct_principle_weekly_doc_uploads (week_start, attempted_at DESC);

CREATE INDEX IF NOT EXISTS idx_principle_weekly_doc_uploads_attempted_at
  ON instinct_principle_weekly_doc_uploads (attempted_at DESC);

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'instinct_principle_weekly_doc_uploads'
       AND column_name IN (
         'id','week_start','status','reason_code','filename','byte_count',
         'parent_drive_id','parent_item_id','web_url','etag','attempted_by',
         'error_message','attempted_at'
       )
  ) = 13, 'instinct_principle_weekly_doc_uploads missing expected columns';
END $$;

COMMIT;
