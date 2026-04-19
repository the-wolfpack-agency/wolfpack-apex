-- Reverse of 043_rename_journals.sql. Reverses the table + index rename
-- AND the backward-compat view. Safe to run against any state: every
-- statement is guarded with IF EXISTS.
--
-- Post-rollback schema matches pre-043 schema exactly: apex_journals is
-- the table, instinct_journals is the migration-014 alias view.

BEGIN;

-- 1. Drop the backward-compat view first so the old name is free for the table.
DROP VIEW IF EXISTS apex_journals;

-- 2. Indexes back to apex_* names.
ALTER INDEX IF EXISTS idx_instinct_journals_date RENAME TO idx_apex_journals_date;
ALTER INDEX IF EXISTS idx_instinct_journals_user RENAME TO idx_apex_journals_user;

-- 3. Table back to its original name.
ALTER TABLE IF EXISTS instinct_journals RENAME TO apex_journals;

-- 4. Restore the migration-014 alias view so post-rollback schema
--    matches pre-043 schema exactly.
CREATE OR REPLACE VIEW instinct_journals AS
  SELECT * FROM apex_journals;

COMMIT;
