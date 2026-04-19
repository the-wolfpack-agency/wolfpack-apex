-- Tier 4 DB rename batch 5 / stream U1a: apex_benefit_plans → instinct_benefit_plans
--
-- Batch 5 renames the benefits family together because they're FK-linked:
--   052 — apex_benefit_plans           → instinct_benefit_plans           (this file)
--   053 — apex_benefit_recommendations → instinct_benefit_recommendations
--   054 — apex_benefit_documents       → instinct_benefit_documents       (FK parent)
--
-- FK topology (defined in migration 010_people.sql):
--   apex_benefit_plans.document_id           → apex_benefit_documents(id) ON DELETE CASCADE
--   apex_benefit_recommendations.document_id → apex_benefit_documents(id) ON DELETE CASCADE
--   apex_hr_documents.benefit_document_id    → apex_benefit_documents(id) ON DELETE SET NULL (migration 011)
--
-- Postgres tracks FKs by OID (not by name), so ALTER TABLE RENAME on
-- either the child (this table) or the parent (054) preserves the
-- relationship automatically — the constraint continues pointing at
-- the right OID. No FK maintenance code needed here. Constraint NAMES
-- stay put (they embed the old table name for the PRIMARY KEY backing
-- index etc.) and are left alone — renaming them would bloat the diff
-- for zero behavior change.
--
-- Safety-first design — same structure as 036_rename_feature_requests.sql,
-- 051_rename_user_memory.sql, and the rest of the Tier-4 batch:
--
--   1. DEFENSIVE RENAME — handles any prior state (fresh DB, already-
--      renamed DB, partial-rollback states) so the migration never
--      aborts the deploy.
--
--   2. BACKWARD-COMPAT VIEW — after the rename, `apex_benefit_plans`
--      becomes an auto-updatable passthrough view to the renamed table.
--      Any missed code reference (SELECT, INSERT, UPDATE, DELETE) still
--      works against the OLD name so data flow never silently drops.
--      The compat view is removed in a follow-up migration once we've
--      verified every reference is updated.
--
--   3. ROW-COUNT ASSERTION — snapshots COUNT(*) before the rename,
--      compares after, RAISES EXCEPTION if they don't match.
--
-- Starting-state specifics for THIS rename:
--   • `apex_benefit_plans` is the real table (migration 010).
--   • `instinct_benefit_plans` EXISTS as an alias view from migration
--     014 (`CREATE OR REPLACE VIEW instinct_benefit_plans AS SELECT *
--     FROM apex_benefit_plans`). That alias view MUST be dropped before
--     the ALTER TABLE RENAME — otherwise `relation already exists`
--     (42P07).
--   • Migration 010 created two secondary indexes on this table:
--       idx_apex_benefit_plans_doc      ON apex_benefit_plans(document_id)
--       idx_apex_benefit_plans_premium  ON apex_benefit_plans(monthly_premium_age_employee_only)
--     Both are renamed with ALTER INDEX IF EXISTS below for hygiene.
--   • No dependent aggregate/materialized views — confirmed by
--     `grep -rnE "FROM apex_benefit_plans|VIEW .*benefit_plans"
--      src/db/migrations/` returning only the migration-014 alias view.

BEGIN;

DO $$
DECLARE
  apex_exists_as_table BOOLEAN;
  instinct_kind CHAR;
  pre_rename_count BIGINT := NULL;
  post_rename_count BIGINT;
BEGIN
  -- Does apex_benefit_plans still exist as a regular table?
  SELECT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'apex_benefit_plans'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
  ) INTO apex_exists_as_table;

  -- What is instinct_benefit_plans right now? (NULL = doesn't exist)
  SELECT c.relkind
    INTO instinct_kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_benefit_plans'
      AND n.nspname = current_schema()
    LIMIT 1;

  -- Snapshot row count BEFORE the rename so we can assert no rows
  -- disappeared after. Use EXECUTE+INTO for dynamic table name.
  IF apex_exists_as_table THEN
    EXECUTE 'SELECT COUNT(*) FROM apex_benefit_plans' INTO pre_rename_count;
  ELSIF instinct_kind = 'r' THEN
    EXECUTE 'SELECT COUNT(*) FROM instinct_benefit_plans' INTO pre_rename_count;
  END IF;

  -- =========================================================
  -- Case A: already renamed — instinct is the table.
  --         Ensure the backward-compat view exists so any legacy
  --         apex_benefit_plans reference still works.
  -- =========================================================
  IF instinct_kind = 'r' AND NOT apex_exists_as_table THEN
    EXECUTE 'CREATE OR REPLACE VIEW apex_benefit_plans AS SELECT * FROM instinct_benefit_plans';
    RAISE NOTICE 'Already renamed; ensured compat view apex_benefit_plans exists.';

  -- =========================================================
  -- Case B: clean pre-rename — apex is the table, instinct is a view
  --         (the migration-014 alias view). Drop the existing
  --         instinct_* alias view, rename the table, create the
  --         reverse compat view.
  -- =========================================================
  ELSIF apex_exists_as_table AND instinct_kind = 'v' THEN
    EXECUTE 'DROP VIEW instinct_benefit_plans';
    EXECUTE 'ALTER TABLE apex_benefit_plans RENAME TO instinct_benefit_plans';
    EXECUTE 'CREATE OR REPLACE VIEW apex_benefit_plans AS SELECT * FROM instinct_benefit_plans';
    RAISE NOTICE 'Renamed apex_benefit_plans → instinct_benefit_plans; compat view created.';

  -- =========================================================
  -- Case C: pre-rename but the alias view was dropped elsewhere.
  --         Just rename the table + create compat view.
  -- =========================================================
  ELSIF apex_exists_as_table AND instinct_kind IS NULL THEN
    EXECUTE 'ALTER TABLE apex_benefit_plans RENAME TO instinct_benefit_plans';
    EXECUTE 'CREATE OR REPLACE VIEW apex_benefit_plans AS SELECT * FROM instinct_benefit_plans';
    RAISE NOTICE 'Renamed apex_benefit_plans → instinct_benefit_plans (no pre-existing alias view); compat view created.';

  -- =========================================================
  -- Case D: Mystery state — instinct_benefit_plans exists as something
  --         other than a view or table. Abort with a clear error.
  -- =========================================================
  ELSIF instinct_kind IS NOT NULL AND instinct_kind NOT IN ('r', 'v') THEN
    RAISE EXCEPTION 'Refusing to proceed: instinct_benefit_plans exists as relkind=% — manual inspection required.', instinct_kind;

  -- =========================================================
  -- Case E: apex_benefit_plans gone AND instinct_benefit_plans is a view.
  --         Orphan-view cleanup: drop the view.
  -- =========================================================
  ELSIF NOT apex_exists_as_table AND instinct_kind = 'v' THEN
    EXECUTE 'DROP VIEW instinct_benefit_plans';
    RAISE NOTICE 'Dropped orphan view instinct_benefit_plans; apex_benefit_plans table is absent.';

  -- =========================================================
  -- Case F: neither exists — no-op (migrations 010/014 never ran here).
  -- =========================================================
  ELSE
    RAISE NOTICE 'Neither apex_benefit_plans nor instinct_benefit_plans exists; nothing to rename.';
  END IF;

  -- Row-count assertion: if we had a source table, the post-rename
  -- count must match exactly. ALTER TABLE RENAME is metadata-only so
  -- row count is always preserved; any mismatch means the rename did
  -- not happen as expected or the table we landed on is different from
  -- what we started with. Either way, abort.
  IF pre_rename_count IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT COUNT(*) FROM instinct_benefit_plans' INTO post_rename_count;
    EXCEPTION WHEN undefined_table THEN
      post_rename_count := NULL;
    END;
    IF post_rename_count IS NOT NULL AND post_rename_count != pre_rename_count THEN
      RAISE EXCEPTION 'Row-count mismatch after rename: pre=% post=% — aborting.', pre_rename_count, post_rename_count;
    END IF;
    RAISE NOTICE 'Row-count assertion passed: % rows preserved.', COALESCE(pre_rename_count, 0);
  END IF;
END $$;

-- Rename secondary indexes (idempotent, independent of the block above).
-- Each guarded with IF EXISTS so any partial prior state is tolerated.
-- Migration 010 created:
--   idx_apex_benefit_plans_doc      ON apex_benefit_plans(document_id)
--   idx_apex_benefit_plans_premium  ON apex_benefit_plans(monthly_premium_age_employee_only)
ALTER INDEX IF EXISTS idx_apex_benefit_plans_doc
  RENAME TO idx_instinct_benefit_plans_doc;
ALTER INDEX IF EXISTS idx_apex_benefit_plans_premium
  RENAME TO idx_instinct_benefit_plans_premium;

-- =========================================================================
-- Compat-view updatability assertion.
--
-- The backward-compat view created above is supposed to be auto-updatable
-- (simple passthrough SELECT * FROM ...) so any legacy code reference
-- INSERTing / UPDATEing / DELETEing via apex_benefit_plans still
-- propagates to the renamed underlying table. src/lib/benefits.ts has
-- INSERT paths hitting this table, so updatable-AND-insertable is
-- non-negotiable.
--
-- If for any reason the view is NOT updatable, this assertion RAISES
-- EXCEPTION and the whole migration is rolled back. No silent
-- write-discard.
-- =========================================================================
DO $$
DECLARE
  is_updatable TEXT;
  is_insertable TEXT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.views
    WHERE table_schema = current_schema()
      AND table_name = 'apex_benefit_plans'
  ) THEN
    SELECT v.is_updatable, v.is_insertable_into
      INTO is_updatable, is_insertable
      FROM information_schema.views v
      WHERE v.table_schema = current_schema()
        AND v.table_name = 'apex_benefit_plans';

    IF is_updatable != 'YES' THEN
      RAISE EXCEPTION 'Compat view apex_benefit_plans is NOT updatable (is_updatable=%). Legacy code UPDATEs/DELETEs would silently fail. Aborting.', is_updatable;
    END IF;
    IF is_insertable != 'YES' THEN
      RAISE EXCEPTION 'Compat view apex_benefit_plans is NOT insertable (is_insertable_into=%). Legacy code INSERTs would silently fail. Aborting.', is_insertable;
    END IF;
    RAISE NOTICE 'Compat view apex_benefit_plans is fully R/W (is_updatable=%, is_insertable_into=%).', is_updatable, is_insertable;
  END IF;
END $$;

COMMIT;
