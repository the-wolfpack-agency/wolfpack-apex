-- Reverse of 042_rename_qbo_tokens.sql. Reverses the table + index
-- rename AND the backward-compat view. Safe to run against any state:
-- every statement is guarded with IF EXISTS.

BEGIN;

-- 1. Drop the backward-compat view first so the old name is free for the table.
DROP VIEW IF EXISTS apex_qbo_tokens;

-- 2. Index back to its original name (from migration 004).
ALTER INDEX IF EXISTS idx_instinct_qbo_tokens_realm RENAME TO idx_qbo_tokens_realm;

-- 3. Table back to its original name.
ALTER TABLE IF EXISTS instinct_qbo_tokens RENAME TO apex_qbo_tokens;

-- 4. Restore the migration-014 alias view so post-rollback schema
--    matches pre-042 schema exactly.
CREATE OR REPLACE VIEW instinct_qbo_tokens AS
  SELECT * FROM apex_qbo_tokens;

COMMIT;
