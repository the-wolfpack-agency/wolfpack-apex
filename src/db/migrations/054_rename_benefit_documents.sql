-- Tier 4 DB rename batch 5 / stream U1c: apex_benefit_documents → instinct_benefit_documents
--
-- Batch 5 renames the benefits family together because they're FK-linked:
--   052 — apex_benefit_plans           → instinct_benefit_plans
--   053 — apex_benefit_recommendations → instinct_benefit_recommendations
--   054 — apex_benefit_documents       → instinct_benefit_documents       (this file)
--
-- This table is the FK PARENT for the other two (plus apex_hr_documents,
-- which is renamed by a separate stream):
--   apex_benefit_plans.document_id           → apex_benefit_documents(id) ON DELETE CASCADE
--   apex_benefit_recommendations.document_id → apex_benefit_documents(id) ON DELETE CASCADE
--   apex_hr_documents.benefit_document_id    → apex_benefit_documents(id) ON DELETE SET NULL (migration 011)
--
-- Postgres tracks FKs by OID (not by name). ALTER TABLE RENAME on a
-- table that is the target of FKs preserves every incoming FK — the
-- child constraints continue pointing at the same OID regardless of
-- the parent's new name. No FK maintenance is required here.
--
-- The only dependent RELATION on this table name is the migration-014
-- alias view `instinct_benefit_documents AS SELECT * FROM
-- apex_benefit_documents`. That view must be dropped before the
-- ALTER TABLE RENAME (otherwise `relation already exists`, 42P07).
--
-- Safety-first design — same structure as 051_rename_user_memory.sql:
--
--   1. DEFENSIVE RENAME — handles any prior state so the migration
--      never aborts the deploy.
--   2. BACKWARD-COMPAT VIEW — auto-updatable passthrough so missed
--      legacy references keep working until the apex_ compat view is
--      retired in a follow-up.
--   3. ROW-COUNT ASSERTION — snapshots COUNT(*) before and after the
--      rename and raises on mismatch.
--
-- Starting-state specifics:
--   • `apex_benefit_documents` is the real table (migration 010). It
--     has no explicit secondary indexes (only the PRIMARY KEY on id).
--   • `instinct_benefit_documents` EXISTS as an alias view from
--     migration 014. Dropped before RENAME.
--   • No dependent aggregate/materialized views — confirmed.

BEGIN;

DO $$
DECLARE
  apex_exists_as_table BOOLEAN;
  instinct_kind CHAR;
  pre_rename_count BIGINT := NULL;
  post_rename_count BIGINT;
BEGIN
  -- Does apex_benefit_documents still exist as a regular table?
  SELECT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'apex_benefit_documents'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
  ) INTO apex_exists_as_table;

  -- What is instinct_benefit_documents right now? (NULL = doesn't exist)
  SELECT c.relkind
    INTO instinct_kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_benefit_documents'
      AND n.nspname = current_schema()
    LIMIT 1;

  IF apex_exists_as_table THEN
    EXECUTE 'SELECT COUNT(*) FROM apex_benefit_documents' INTO pre_rename_count;
  ELSIF instinct_kind = 'r' THEN
    EXECUTE 'SELECT COUNT(*) FROM instinct_benefit_documents' INTO pre_rename_count;
  END IF;

  -- Case A: already renamed — ensure compat view exists.
  IF instinct_kind = 'r' AND NOT apex_exists_as_table THEN
    EXECUTE 'CREATE OR REPLACE VIEW apex_benefit_documents AS SELECT * FROM instinct_benefit_documents';
    RAISE NOTICE 'Already renamed; ensured compat view apex_benefit_documents exists.';

  -- Case B: clean pre-rename — drop alias view, rename, create compat view.
  ELSIF apex_exists_as_table AND instinct_kind = 'v' THEN
    EXECUTE 'DROP VIEW instinct_benefit_documents';
    EXECUTE 'ALTER TABLE apex_benefit_documents RENAME TO instinct_benefit_documents';
    EXECUTE 'CREATE OR REPLACE VIEW apex_benefit_documents AS SELECT * FROM instinct_benefit_documents';
    RAISE NOTICE 'Renamed apex_benefit_documents → instinct_benefit_documents; compat view created.';

  -- Case C: pre-rename, alias view already gone.
  ELSIF apex_exists_as_table AND instinct_kind IS NULL THEN
    EXECUTE 'ALTER TABLE apex_benefit_documents RENAME TO instinct_benefit_documents';
    EXECUTE 'CREATE OR REPLACE VIEW apex_benefit_documents AS SELECT * FROM instinct_benefit_documents';
    RAISE NOTICE 'Renamed apex_benefit_documents → instinct_benefit_documents (no pre-existing alias view); compat view created.';

  -- Case D: mystery state — abort.
  ELSIF instinct_kind IS NOT NULL AND instinct_kind NOT IN ('r', 'v') THEN
    RAISE EXCEPTION 'Refusing to proceed: instinct_benefit_documents exists as relkind=% — manual inspection required.', instinct_kind;

  -- Case E: orphan view cleanup.
  ELSIF NOT apex_exists_as_table AND instinct_kind = 'v' THEN
    EXECUTE 'DROP VIEW instinct_benefit_documents';
    RAISE NOTICE 'Dropped orphan view instinct_benefit_documents; apex_benefit_documents table is absent.';

  -- Case F: nothing exists — no-op.
  ELSE
    RAISE NOTICE 'Neither apex_benefit_documents nor instinct_benefit_documents exists; nothing to rename.';
  END IF;

  -- Row-count assertion.
  IF pre_rename_count IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT COUNT(*) FROM instinct_benefit_documents' INTO post_rename_count;
    EXCEPTION WHEN undefined_table THEN
      post_rename_count := NULL;
    END;
    IF post_rename_count IS NOT NULL AND post_rename_count != pre_rename_count THEN
      RAISE EXCEPTION 'Row-count mismatch after rename: pre=% post=% — aborting.', pre_rename_count, post_rename_count;
    END IF;
    RAISE NOTICE 'Row-count assertion passed: % rows preserved.', COALESCE(pre_rename_count, 0);
  END IF;
END $$;

-- Migration 010 created no secondary indexes on apex_benefit_documents.
-- The PRIMARY KEY backing index is auto-renamed by Postgres on ALTER
-- TABLE RENAME (in modern versions); older versions keep the original
-- constraint name. Either way, no explicit action required.

-- Compat-view updatability assertion (same pattern as 051).
DO $$
DECLARE
  is_updatable TEXT;
  is_insertable TEXT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.views
    WHERE table_schema = current_schema()
      AND table_name = 'apex_benefit_documents'
  ) THEN
    SELECT v.is_updatable, v.is_insertable_into
      INTO is_updatable, is_insertable
      FROM information_schema.views v
      WHERE v.table_schema = current_schema()
        AND v.table_name = 'apex_benefit_documents';

    IF is_updatable != 'YES' THEN
      RAISE EXCEPTION 'Compat view apex_benefit_documents is NOT updatable (is_updatable=%). Aborting.', is_updatable;
    END IF;
    IF is_insertable != 'YES' THEN
      RAISE EXCEPTION 'Compat view apex_benefit_documents is NOT insertable (is_insertable_into=%). Aborting.', is_insertable;
    END IF;
    RAISE NOTICE 'Compat view apex_benefit_documents is fully R/W (is_updatable=%, is_insertable_into=%).', is_updatable, is_insertable;
  END IF;
END $$;

COMMIT;
