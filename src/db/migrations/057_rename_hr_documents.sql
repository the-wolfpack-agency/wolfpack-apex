-- Tier 4 DB rename batch 5 / stream U3 (hr family, part 2): apex_hr_documents → instinct_hr_documents
--
-- Sibling migrations in this batch (parallel streams, disjoint scope):
--   055 — (other stream)
--   056 — apex_employees       → instinct_employees       (U3, part 1, precedes this)
--   057 — apex_hr_documents    → instinct_hr_documents    (U3, this file, part 2)
--   058 — (other stream)
--
-- This is the HR family — part 2. Migration 056 (immediately preceding)
-- renamed apex_employees → instinct_employees. This table has a FOREIGN
-- KEY on apex_hr_documents.employee_id referencing apex_employees(id).
-- Postgres tracks FKs by OID (not relation name), so 056's parent-rename
-- automatically keeps this child's FK pointing at the renamed parent —
-- no FK maintenance is required here.
--
-- Safety-first design — same structure as 036, 048, 051.
--
--   1. DEFENSIVE RENAME
--   2. BACKWARD-COMPAT VIEW (auto-updatable passthrough)
--   3. ROW-COUNT ASSERTION
--
-- Starting-state specifics for THIS rename:
--   • `apex_hr_documents` is the real table (migration 011, extended by
--     migration 012 which added a metadata JSONB column).
--
--   • `instinct_hr_documents` EXISTS as an alias view from migration 014
--     (`CREATE OR REPLACE VIEW instinct_hr_documents AS SELECT * FROM
--      apex_hr_documents`). That alias view MUST be dropped before the
--     ALTER TABLE RENAME — otherwise `relation already exists` (42P07).
--
--   • Migration 011 defined:
--       - PRIMARY KEY on (id) — auto-named apex_hr_documents_pkey.
--       - FK apex_hr_documents.employee_id → apex_employees(id)
--         ON DELETE SET NULL. After migration 056 the parent is named
--         instinct_employees, but the FK follows by OID.
--       - FK apex_hr_documents.benefit_document_id →
--         apex_benefit_documents(id) ON DELETE SET NULL. Unchanged.
--       - 4 secondary indexes:
--           idx_apex_hr_documents_category  ON (category)
--           idx_apex_hr_documents_employee  ON (employee_id)
--           idx_apex_hr_documents_uploaded  ON (uploaded_at DESC)
--           idx_apex_hr_documents_expires   ON (expires_at) WHERE expires_at IS NOT NULL
--
--   • Migration 012 added a `metadata JSONB` column — non-structural,
--     does not affect the rename.
--
--   • No aggregate views (materialized or regular) depend on
--     apex_hr_documents beyond the migration-014 alias view. Verified
--     by: grep -rnE "FROM apex_hr_documents|JOIN apex_hr_documents" src/db/migrations/

BEGIN;

DO $$
DECLARE
  apex_exists_as_table BOOLEAN;
  instinct_kind CHAR;
  pre_rename_count BIGINT := NULL;
  post_rename_count BIGINT;
BEGIN
  -- Does apex_hr_documents still exist as a regular table?
  SELECT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'apex_hr_documents'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
  ) INTO apex_exists_as_table;

  -- What is instinct_hr_documents right now? (NULL = doesn't exist)
  SELECT c.relkind
    INTO instinct_kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_hr_documents'
      AND n.nspname = current_schema()
    LIMIT 1;

  -- Snapshot row count BEFORE the rename.
  IF apex_exists_as_table THEN
    EXECUTE 'SELECT COUNT(*) FROM apex_hr_documents' INTO pre_rename_count;
  ELSIF instinct_kind = 'r' THEN
    EXECUTE 'SELECT COUNT(*) FROM instinct_hr_documents' INTO pre_rename_count;
  END IF;

  -- =========================================================
  -- Case A: already renamed — instinct is the table.
  -- =========================================================
  IF instinct_kind = 'r' AND NOT apex_exists_as_table THEN
    EXECUTE 'CREATE OR REPLACE VIEW apex_hr_documents AS SELECT * FROM instinct_hr_documents';
    RAISE NOTICE 'Already renamed; ensured compat view apex_hr_documents exists.';

  -- =========================================================
  -- Case B: clean pre-rename — apex is the table, instinct is a view.
  -- =========================================================
  ELSIF apex_exists_as_table AND instinct_kind = 'v' THEN
    EXECUTE 'DROP VIEW instinct_hr_documents';
    EXECUTE 'ALTER TABLE apex_hr_documents RENAME TO instinct_hr_documents';
    EXECUTE 'CREATE OR REPLACE VIEW apex_hr_documents AS SELECT * FROM instinct_hr_documents';
    RAISE NOTICE 'Renamed apex_hr_documents → instinct_hr_documents; compat view created.';

  -- =========================================================
  -- Case C: pre-rename but the alias view was dropped elsewhere.
  -- =========================================================
  ELSIF apex_exists_as_table AND instinct_kind IS NULL THEN
    EXECUTE 'ALTER TABLE apex_hr_documents RENAME TO instinct_hr_documents';
    EXECUTE 'CREATE OR REPLACE VIEW apex_hr_documents AS SELECT * FROM instinct_hr_documents';
    RAISE NOTICE 'Renamed apex_hr_documents → instinct_hr_documents (no pre-existing alias view); compat view created.';

  -- =========================================================
  -- Case D: Mystery state.
  -- =========================================================
  ELSIF instinct_kind IS NOT NULL AND instinct_kind NOT IN ('r', 'v') THEN
    RAISE EXCEPTION 'Refusing to proceed: instinct_hr_documents exists as relkind=% — manual inspection required.', instinct_kind;

  -- =========================================================
  -- Case E: apex gone AND instinct is a view. Orphan-view cleanup.
  -- =========================================================
  ELSIF NOT apex_exists_as_table AND instinct_kind = 'v' THEN
    EXECUTE 'DROP VIEW instinct_hr_documents';
    RAISE NOTICE 'Dropped orphan view instinct_hr_documents; apex_hr_documents table is absent.';

  -- =========================================================
  -- Case F: neither exists — no-op.
  -- =========================================================
  ELSE
    RAISE NOTICE 'Neither apex_hr_documents nor instinct_hr_documents exists; nothing to rename.';
  END IF;

  -- Row-count assertion.
  IF pre_rename_count IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT COUNT(*) FROM instinct_hr_documents' INTO post_rename_count;
    EXCEPTION WHEN undefined_table THEN
      post_rename_count := NULL;
    END;
    IF post_rename_count IS NOT NULL AND post_rename_count != pre_rename_count THEN
      RAISE EXCEPTION 'Row-count mismatch after rename: pre=% post=% — aborting.', pre_rename_count, post_rename_count;
    END IF;
    RAISE NOTICE 'Row-count assertion passed: % rows preserved.', COALESCE(pre_rename_count, 0);
  END IF;
END $$;

-- Rename the 4 secondary indexes (idempotent, guarded).
ALTER INDEX IF EXISTS idx_apex_hr_documents_category RENAME TO idx_instinct_hr_documents_category;
ALTER INDEX IF EXISTS idx_apex_hr_documents_employee RENAME TO idx_instinct_hr_documents_employee;
ALTER INDEX IF EXISTS idx_apex_hr_documents_uploaded RENAME TO idx_instinct_hr_documents_uploaded;
ALTER INDEX IF EXISTS idx_apex_hr_documents_expires  RENAME TO idx_instinct_hr_documents_expires;

-- Rename the auto-named PRIMARY KEY constraint for hygiene
-- (`apex_hr_documents_pkey` → `instinct_hr_documents_pkey`).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'apex_hr_documents_pkey'
      AND n.nspname = current_schema()
  ) THEN
    EXECUTE 'ALTER TABLE instinct_hr_documents '
         || 'RENAME CONSTRAINT apex_hr_documents_pkey '
         || 'TO instinct_hr_documents_pkey';
    RAISE NOTICE 'Renamed PRIMARY KEY constraint apex_hr_documents_pkey.';
  END IF;
END $$;

ALTER INDEX IF EXISTS apex_hr_documents_pkey
  RENAME TO instinct_hr_documents_pkey;

-- =========================================================================
-- Compat-view updatability assertion.
-- =========================================================================
DO $$
DECLARE
  is_updatable TEXT;
  is_insertable TEXT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.views
    WHERE table_schema = current_schema()
      AND table_name = 'apex_hr_documents'
  ) THEN
    SELECT v.is_updatable, v.is_insertable_into
      INTO is_updatable, is_insertable
      FROM information_schema.views v
      WHERE v.table_schema = current_schema()
        AND v.table_name = 'apex_hr_documents';

    IF is_updatable != 'YES' THEN
      RAISE EXCEPTION 'Compat view apex_hr_documents is NOT updatable (is_updatable=%). Legacy code UPDATEs/DELETEs would silently fail. Aborting.', is_updatable;
    END IF;
    IF is_insertable != 'YES' THEN
      RAISE EXCEPTION 'Compat view apex_hr_documents is NOT insertable (is_insertable_into=%). Legacy code INSERTs would silently fail. Aborting.', is_insertable;
    END IF;
    RAISE NOTICE 'Compat view apex_hr_documents is fully R/W (is_updatable=%, is_insertable_into=%).', is_updatable, is_insertable;
  END IF;
END $$;

COMMIT;
