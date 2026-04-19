-- Reverse of 055_rename_brief_edit_insights_snapshots.sql. Reverses
-- the table rename AND the backward-compat view. Safe to run against
-- any state: every statement is guarded with IF EXISTS.
--
-- Post-rollback schema matches pre-055 schema exactly:
-- apex_brief_edit_insights_snapshots is the table,
-- instinct_brief_edit_insights_snapshots is the migration-030 alias
-- view.

BEGIN;

-- 1. Drop the backward-compat view first so the old name is free for
--    the table.
DROP VIEW IF EXISTS apex_brief_edit_insights_snapshots;

-- 2. Table back to its original name. No secondary index renames needed
--    (migration 030's index name is not table-name-prefixed) and no
--    auto-named UNIQUE constraint to reverse.
ALTER TABLE IF EXISTS instinct_brief_edit_insights_snapshots
  RENAME TO apex_brief_edit_insights_snapshots;

-- 3. Restore the migration-030 alias view so post-rollback schema
--    matches pre-055 schema exactly.
CREATE OR REPLACE VIEW instinct_brief_edit_insights_snapshots AS
  SELECT * FROM apex_brief_edit_insights_snapshots;

COMMIT;
