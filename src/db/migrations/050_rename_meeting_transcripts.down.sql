-- Reverse of 050_rename_meeting_transcripts.sql. Reverses the table +
-- index rename AND the backward-compat view AND the learning-view
-- rebuild. Safe to run against any state: every statement is guarded
-- with IF EXISTS.
--
-- Post-rollback schema matches pre-050 schema exactly:
--   - apex_meeting_transcripts is the table
--   - instinct_meeting_transcripts is the migration-014 alias view
--   - apex_v_meeting_ingestion_quality selects FROM apex_meeting_transcripts

BEGIN;

-- 1. Drop the dependent learning view so the RENAME can proceed —
--    same constraint as the forward migration, just in reverse.
DROP VIEW IF EXISTS apex_v_meeting_ingestion_quality;

-- 2. Drop the backward-compat view so the old name is free for the table.
DROP VIEW IF EXISTS apex_meeting_transcripts;

-- 3. Indexes back to apex_* names.
ALTER INDEX IF EXISTS idx_instinct_meeting_transcripts_recorded_at
  RENAME TO idx_apex_meeting_transcripts_recorded_at;
ALTER INDEX IF EXISTS idx_instinct_meeting_transcripts_owner
  RENAME TO idx_apex_meeting_transcripts_owner;
ALTER INDEX IF EXISTS idx_instinct_meeting_transcripts_file_id
  RENAME TO idx_apex_meeting_transcripts_file_id;

-- 4. Table back to its original name.
ALTER TABLE IF EXISTS instinct_meeting_transcripts RENAME TO apex_meeting_transcripts;

-- 5. Restore the migration-014 alias view so post-rollback schema
--    matches pre-050 schema exactly.
CREATE OR REPLACE VIEW instinct_meeting_transcripts AS
  SELECT * FROM apex_meeting_transcripts;

-- 6. Restore the migration-007 learning view pointing at the original
--    table name. Only recreate if the underlying table actually exists
--    (skip on databases that never had migration 007 applied).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'apex_meeting_transcripts'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
  ) THEN
    EXECUTE $v$CREATE OR REPLACE VIEW apex_v_meeting_ingestion_quality AS
      SELECT
        owner_user_id,
        COUNT(*)                                                    AS total_transcripts,
        SUM(CASE WHEN quality_status = 'pass'   THEN 1 ELSE 0 END)  AS passed,
        SUM(CASE WHEN quality_status = 'warn'   THEN 1 ELSE 0 END)  AS warned,
        SUM(CASE WHEN quality_status = 'reject' THEN 1 ELSE 0 END)  AS rejected,
        MAX(ingested_at)                                            AS last_ingest_at,
        AVG(duration_seconds)::INTEGER                              AS avg_duration_seconds
      FROM apex_meeting_transcripts
      GROUP BY owner_user_id$v$;
  END IF;
END $$;

COMMIT;
