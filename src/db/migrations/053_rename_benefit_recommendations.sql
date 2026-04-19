-- Tier 4 DB rename batch 5 / stream U1b: apex_benefit_recommendations → instinct_benefit_recommendations
--
-- Batch 5 renames the benefits family together because they're FK-linked:
--   052 — apex_benefit_plans           → instinct_benefit_plans
--   053 — apex_benefit_recommendations → instinct_benefit_recommendations (this file)
--   054 — apex_benefit_documents       → instinct_benefit_documents       (FK parent)
--
-- FK topology (migration 010_people.sql):
--   apex_benefit_recommendations.document_id → apex_benefit_documents(id) ON DELETE CASCADE
--
-- Postgres tracks FKs by OID (not by name); ALTER TABLE RENAME on
-- either side preserves the relationship. Constraint names are left
-- alone (auto-named by Postgres with the old table name baked in —
-- renaming them would bloat the diff for zero behavior change; they do
-- not collide with anything).
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
--   • `apex_benefit_recommendations` is the real table (migration 010).
--   • `instinct_benefit_recommendations` EXISTS as an alias view from
--     migration 014. It must be dropped before ALTER TABLE RENAME.
--   • Migration 010 created one secondary index:
--       idx_apex_benefit_recs_doc ON apex_benefit_recommendations(document_id)
--     Renamed below with ALTER INDEX IF EXISTS.
--   • No dependent aggregate/materialized views — confirmed.

BEGIN;

DO $$
DECLARE
  apex_exists_as_table BOOLEAN;
  instinct_kind CHAR;
  pre_rename_count BIGINT := NULL;
  post_rename_count BIGINT;
BEGIN
  -- Does apex_benefit_recommendations still exist as a regular table?
  SELECT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'apex_benefit_recommendations'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
  ) INTO apex_exists_as_table;

  -- What is instinct_benefit_recommendations right now? (NULL = doesn't exist)
  SELECT c.relkind
    INTO instinct_kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_benefit_recommendations'
      AND n.nspname = current_schema()
    LIMIT 1;

  IF apex_exists_as_table THEN
    EXECUTE 'SELECT COUNT(*) FROM apex_benefit_recommendations' INTO pre_rename_count;
  ELSIF instinct_kind = 'r' THEN
    EXECUTE 'SELECT COUNT(*) FROM instinct_benefit_recommendations' INTO pre_rename_count;
  END IF;

  -- Case A: already renamed — ensure compat view exists.
  IF instinct_kind = 'r' AND NOT apex_exists_as_table THEN
    EXECUTE 'CREATE OR REPLACE VIEW apex_benefit_recommendations AS SELECT * FROM instinct_benefit_recommendations';
    RAISE NOTICE 'Already renamed; ensured compat view apex_benefit_recommendations exists.';

  -- Case B: clean pre-rename — drop alias view, rename, create compat view.
  ELSIF apex_exists_as_table AND instinct_kind = 'v' THEN
    EXECUTE 'DROP VIEW instinct_benefit_recommendations';
    EXECUTE 'ALTER TABLE apex_benefit_recommendations RENAME TO instinct_benefit_recommendations';
    EXECUTE 'CREATE OR REPLACE VIEW apex_benefit_recommendations AS SELECT * FROM instinct_benefit_recommendations';
    RAISE NOTICE 'Renamed apex_benefit_recommendations → instinct_benefit_recommendations; compat view created.';

  -- Case C: pre-rename, alias view already gone.
  ELSIF apex_exists_as_table AND instinct_kind IS NULL THEN
    EXECUTE 'ALTER TABLE apex_benefit_recommendations RENAME TO instinct_benefit_recommendations';
    EXECUTE 'CREATE OR REPLACE VIEW apex_benefit_recommendations AS SELECT * FROM instinct_benefit_recommendations';
    RAISE NOTICE 'Renamed apex_benefit_recommendations → instinct_benefit_recommendations (no pre-existing alias view); compat view created.';

  -- Case D: mystery state — abort.
  ELSIF instinct_kind IS NOT NULL AND instinct_kind NOT IN ('r', 'v') THEN
    RAISE EXCEPTION 'Refusing to proceed: instinct_benefit_recommendations exists as relkind=% — manual inspection required.', instinct_kind;

  -- Case E: orphan view cleanup.
  ELSIF NOT apex_exists_as_table AND instinct_kind = 'v' THEN
    EXECUTE 'DROP VIEW instinct_benefit_recommendations';
    RAISE NOTICE 'Dropped orphan view instinct_benefit_recommendations; apex_benefit_recommendations table is absent.';

  -- Case F: nothing exists — no-op.
  ELSE
    RAISE NOTICE 'Neither apex_benefit_recommendations nor instinct_benefit_recommendations exists; nothing to rename.';
  END IF;

  -- Row-count assertion.
  IF pre_rename_count IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT COUNT(*) FROM instinct_benefit_recommendations' INTO post_rename_count;
    EXCEPTION WHEN undefined_table THEN
      post_rename_count := NULL;
    END;
    IF post_rename_count IS NOT NULL AND post_rename_count != pre_rename_count THEN
      RAISE EXCEPTION 'Row-count mismatch after rename: pre=% post=% — aborting.', pre_rename_count, post_rename_count;
    END IF;
    RAISE NOTICE 'Row-count assertion passed: % rows preserved.', COALESCE(pre_rename_count, 0);
  END IF;
END $$;

-- Rename secondary index.
-- Migration 010 created:
--   idx_apex_benefit_recs_doc ON apex_benefit_recommendations(document_id)
ALTER INDEX IF EXISTS idx_apex_benefit_recs_doc
  RENAME TO idx_instinct_benefit_recs_doc;

-- Compat-view updatability assertion (same pattern as 051).
DO $$
DECLARE
  is_updatable TEXT;
  is_insertable TEXT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.views
    WHERE table_schema = current_schema()
      AND table_name = 'apex_benefit_recommendations'
  ) THEN
    SELECT v.is_updatable, v.is_insertable_into
      INTO is_updatable, is_insertable
      FROM information_schema.views v
      WHERE v.table_schema = current_schema()
        AND v.table_name = 'apex_benefit_recommendations';

    IF is_updatable != 'YES' THEN
      RAISE EXCEPTION 'Compat view apex_benefit_recommendations is NOT updatable (is_updatable=%). Aborting.', is_updatable;
    END IF;
    IF is_insertable != 'YES' THEN
      RAISE EXCEPTION 'Compat view apex_benefit_recommendations is NOT insertable (is_insertable_into=%). Aborting.', is_insertable;
    END IF;
    RAISE NOTICE 'Compat view apex_benefit_recommendations is fully R/W (is_updatable=%, is_insertable_into=%).', is_updatable, is_insertable;
  END IF;
END $$;

COMMIT;
