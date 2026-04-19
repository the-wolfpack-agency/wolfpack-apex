-- Reverse of 045_rename_hr_insights.sql. Reverses the table + index
-- rename AND the backward-compat view. Safe to run against any state:
-- every statement is guarded with IF EXISTS.
--
-- Post-rollback schema matches pre-045 schema exactly: apex_hr_insights
-- is the table, instinct_hr_insights is the migration-014 alias view.

BEGIN;

-- 1. Drop the backward-compat view first so the old name is free for the table.
DROP VIEW IF EXISTS apex_hr_insights;

-- 2. Indexes back to apex_* names.
ALTER INDEX IF EXISTS idx_instinct_hr_insights_status RENAME TO idx_apex_hr_insights_status;

-- 3. Table back to its original name.
ALTER TABLE IF EXISTS instinct_hr_insights RENAME TO apex_hr_insights;

-- 4. Restore the migration-014 alias view so post-rollback schema
--    matches pre-045 schema exactly.
CREATE OR REPLACE VIEW instinct_hr_insights AS
  SELECT * FROM apex_hr_insights;

COMMIT;
