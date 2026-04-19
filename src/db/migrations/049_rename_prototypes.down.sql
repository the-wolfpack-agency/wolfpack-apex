-- Reverse of 049_rename_prototypes.sql. Reverses the table + index rename
-- AND the backward-compat view. Safe to run against any state: every
-- statement is guarded with IF EXISTS.
--
-- Post-rollback schema matches pre-049 schema exactly: apex_prototypes is
-- the table, instinct_prototypes is the migration-014 alias view.

BEGIN;

-- 1. Drop the backward-compat view first so the old name is free for the table.
DROP VIEW IF EXISTS apex_prototypes;

-- 2. Indexes back to apex_* names.
ALTER INDEX IF EXISTS idx_instinct_prototypes_status     RENAME TO idx_apex_prototypes_status;
ALTER INDEX IF EXISTS idx_instinct_prototypes_created_by RENAME TO idx_apex_prototypes_created_by;

-- 3. Table back to its original name.
ALTER TABLE IF EXISTS instinct_prototypes RENAME TO apex_prototypes;

-- 4. Restore the migration-014 alias view so post-rollback schema
--    matches pre-049 schema exactly.
CREATE OR REPLACE VIEW instinct_prototypes AS
  SELECT * FROM apex_prototypes;

COMMIT;
