-- Reverse of 041_rename_plaud_connections.sql. Reverses the table +
-- index rename AND the backward-compat view. Safe to run against any
-- state: every statement is guarded with IF EXISTS.

BEGIN;

-- 1. Drop the backward-compat view first so the old name is free for the table.
DROP VIEW IF EXISTS apex_plaud_connections;

-- 2. Index back to apex_* name.
ALTER INDEX IF EXISTS idx_instinct_plaud_connections_scope
  RENAME TO idx_apex_plaud_connections_scope;

-- 3. Table back to its original name.
ALTER TABLE IF EXISTS instinct_plaud_connections RENAME TO apex_plaud_connections;

-- 4. Restore the migration-014 alias view so post-rollback schema
--    matches pre-041 schema exactly.
CREATE OR REPLACE VIEW instinct_plaud_connections AS
  SELECT * FROM apex_plaud_connections;

COMMIT;
