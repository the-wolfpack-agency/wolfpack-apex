-- Reverse of 058_rename_clients.sql. Reverses the table + index rename
-- AND the backward-compat view. Safe to run against any state: every
-- statement is guarded with IF EXISTS.
--
-- Post-rollback schema matches pre-058 schema exactly: apex_clients is
-- the table, instinct_clients is the migration-014 alias view.

BEGIN;

-- 1. Drop the backward-compat view first so the old name is free for the table.
DROP VIEW IF EXISTS apex_clients;

-- 2. Index back to apex_* name.
ALTER INDEX IF EXISTS idx_instinct_clients_name RENAME TO idx_apex_clients_name;

-- 3. Table back to its original name.
ALTER TABLE IF EXISTS instinct_clients RENAME TO apex_clients;

-- 4. Restore the migration-014 alias view so post-rollback schema
--    matches pre-058 schema exactly.
CREATE OR REPLACE VIEW instinct_clients AS
  SELECT * FROM apex_clients;

COMMIT;
