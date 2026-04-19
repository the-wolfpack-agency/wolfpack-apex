-- Reverse of 057_rename_hr_documents.sql. Reverses the table rename,
-- the 4 secondary index renames, the PRIMARY KEY constraint rename, and
-- the backward-compat view. Safe to run against any state: every
-- statement is guarded with IF EXISTS.
--
-- Post-rollback schema matches pre-057 schema exactly: apex_hr_documents
-- is the table, instinct_hr_documents is the migration-014 alias view.
--
-- NOTE: When rolling back the whole HR-family batch, run THIS file
-- BEFORE 056.down.sql — the child table must be reverted before the
-- parent. (FKs follow by OID either way, but keeping order mirrors
-- the apply direction.)

BEGIN;

-- 1. Drop the backward-compat view first.
DROP VIEW IF EXISTS apex_hr_documents;

-- 2. Secondary indexes back to apex_* names.
ALTER INDEX IF EXISTS idx_instinct_hr_documents_category RENAME TO idx_apex_hr_documents_category;
ALTER INDEX IF EXISTS idx_instinct_hr_documents_employee RENAME TO idx_apex_hr_documents_employee;
ALTER INDEX IF EXISTS idx_instinct_hr_documents_uploaded RENAME TO idx_apex_hr_documents_uploaded;
ALTER INDEX IF EXISTS idx_instinct_hr_documents_expires  RENAME TO idx_apex_hr_documents_expires;

-- 3. PRIMARY KEY constraint rename back.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'instinct_hr_documents_pkey'
      AND n.nspname = current_schema()
  ) THEN
    EXECUTE 'ALTER TABLE instinct_hr_documents '
         || 'RENAME CONSTRAINT instinct_hr_documents_pkey '
         || 'TO apex_hr_documents_pkey';
  END IF;
END $$;

ALTER INDEX IF EXISTS instinct_hr_documents_pkey
  RENAME TO apex_hr_documents_pkey;

-- 4. Table back to its original name.
ALTER TABLE IF EXISTS instinct_hr_documents RENAME TO apex_hr_documents;

-- 5. Restore the migration-014 alias view.
CREATE OR REPLACE VIEW instinct_hr_documents AS
  SELECT * FROM apex_hr_documents;

COMMIT;
