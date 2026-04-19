-- Reverse of 051_rename_user_memory.sql. Reverses the table rename,
-- the two secondary index renames, the UNIQUE constraint + backing-index
-- rename, AND the backward-compat view. Safe to run against any state:
-- every statement is guarded with IF EXISTS.
--
-- Post-rollback schema matches pre-051 schema exactly:
-- apex_user_memory is the table, instinct_user_memory is the migration-014
-- alias view.

BEGIN;

-- 1. Drop the backward-compat view first so the old name is free for the table.
DROP VIEW IF EXISTS apex_user_memory;

-- 2. Secondary indexes back to apex_* names.
ALTER INDEX IF EXISTS idx_instinct_user_memory_type RENAME TO idx_apex_user_memory_type;
ALTER INDEX IF EXISTS idx_instinct_user_memory_user RENAME TO idx_apex_user_memory_user;

-- 3. UNIQUE constraint back to its auto-generated apex_* name, and the
--    backing index alongside it. Guarded DO block so this reverses only
--    if the constraint actually has the instinct_* name.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'instinct_user_memory_user_id_memory_type_key_key'
      AND n.nspname = current_schema()
  ) THEN
    EXECUTE 'ALTER TABLE instinct_user_memory '
         || 'RENAME CONSTRAINT instinct_user_memory_user_id_memory_type_key_key '
         || 'TO apex_user_memory_user_id_memory_type_key_key';
  END IF;
END $$;

ALTER INDEX IF EXISTS instinct_user_memory_user_id_memory_type_key_key
  RENAME TO apex_user_memory_user_id_memory_type_key_key;

-- 4. Table back to its original name.
ALTER TABLE IF EXISTS instinct_user_memory RENAME TO apex_user_memory;

-- 5. Restore the migration-014 alias view so post-rollback schema
--    matches pre-051 schema exactly.
CREATE OR REPLACE VIEW instinct_user_memory AS
  SELECT * FROM apex_user_memory;

COMMIT;
