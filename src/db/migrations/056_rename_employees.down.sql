-- Reverse of 056_rename_employees.sql. Reverses the table rename,
-- the secondary index rename, the UNIQUE + PRIMARY KEY constraint renames,
-- and the backward-compat view. Safe to run against any state: every
-- statement is guarded with IF EXISTS.
--
-- Post-rollback schema matches pre-056 schema exactly: apex_employees is
-- the table, instinct_employees is the migration-014 alias view.
--
-- NOTE: 057 renames apex_hr_documents (which FKs apex_employees). When
-- rolling back the whole batch, roll back 057 FIRST, then 056. The FK is
-- tracked by OID and follows the parent rename either way.

BEGIN;

-- 1. Drop the backward-compat view first so the old name is free for the table.
DROP VIEW IF EXISTS apex_employees;

-- 2. Secondary index back to apex_* name.
ALTER INDEX IF EXISTS idx_instinct_employees_status RENAME TO idx_apex_employees_status;

-- 3. UNIQUE constraint on email back to its auto-generated apex_* name,
--    and its backing index alongside.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'instinct_employees_email_key'
      AND n.nspname = current_schema()
  ) THEN
    EXECUTE 'ALTER TABLE instinct_employees '
         || 'RENAME CONSTRAINT instinct_employees_email_key '
         || 'TO apex_employees_email_key';
  END IF;
END $$;

ALTER INDEX IF EXISTS instinct_employees_email_key
  RENAME TO apex_employees_email_key;

-- 4. PRIMARY KEY constraint rename back.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'instinct_employees_pkey'
      AND n.nspname = current_schema()
  ) THEN
    EXECUTE 'ALTER TABLE instinct_employees '
         || 'RENAME CONSTRAINT instinct_employees_pkey '
         || 'TO apex_employees_pkey';
  END IF;
END $$;

ALTER INDEX IF EXISTS instinct_employees_pkey
  RENAME TO apex_employees_pkey;

-- 5. Table back to its original name.
ALTER TABLE IF EXISTS instinct_employees RENAME TO apex_employees;

-- 6. Restore the migration-014 alias view so post-rollback schema
--    matches pre-056 schema exactly.
CREATE OR REPLACE VIEW instinct_employees AS
  SELECT * FROM apex_employees;

COMMIT;
