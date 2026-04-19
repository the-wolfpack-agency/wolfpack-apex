-- Reverse of 044_rename_ms_tokens.sql. Reverses the table + indexes
-- rename AND the backward-compat view. Safe to run against any state:
-- every statement is guarded with IF EXISTS.
--
-- Post-rollback schema matches pre-044 schema exactly: apex_ms_tokens is
-- the table, instinct_ms_tokens is the migration-014 alias view.

BEGIN;

-- 1. Drop the backward-compat view first so the old name is free for the table.
DROP VIEW IF EXISTS apex_ms_tokens;

-- 2. Indexes back to apex_* names.
ALTER INDEX IF EXISTS idx_instinct_ms_tokens_email
  RENAME TO idx_apex_ms_tokens_email;
ALTER INDEX IF EXISTS idx_instinct_ms_tokens_connected_by
  RENAME TO idx_apex_ms_tokens_connected_by;

-- 3. Table back to its original name.
ALTER TABLE IF EXISTS instinct_ms_tokens RENAME TO apex_ms_tokens;

-- 4. Restore the migration-014 alias view so post-rollback schema
--    matches pre-044 schema exactly.
CREATE OR REPLACE VIEW instinct_ms_tokens AS
  SELECT * FROM apex_ms_tokens;

COMMIT;
