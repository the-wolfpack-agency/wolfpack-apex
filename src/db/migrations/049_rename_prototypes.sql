-- Tier 4 DB rename batch 4 / stream U2: apex_prototypes → instinct_prototypes
--
-- Sibling migrations in this batch:
--   048 — apex_onboarding_instances  → instinct_onboarding_instances  (U1)
--   049 — apex_prototypes            → instinct_prototypes            (this file)
--   050 — apex_meeting_transcripts   → instinct_meeting_transcripts   (U3)
--   051 — apex_user_memory           → instinct_user_memory           (U4)
--
-- Safety-first design — same structure as 036_rename_feature_requests.sql
-- and 043_rename_journals.sql:
--
--   1. DEFENSIVE RENAME — handles any prior state (fresh DB, already-
--      renamed DB, partial-rollback states) so the migration never
--      aborts the deploy.
--
--   2. BACKWARD-COMPAT VIEW — after the rename, `apex_prototypes` becomes
--      an auto-updatable passthrough view to the renamed table. Any
--      missed code reference (SELECT, INSERT, UPDATE, DELETE) still works
--      against the OLD name so data flow never silently drops.
--
--   3. ROW-COUNT ASSERTION — snapshots COUNT(*) before the rename,
--      compares after, RAISES EXCEPTION if they don't match.
--
-- Starting-state specifics for THIS rename:
--   • `apex_prototypes` is the real table (migration 001, section 8
--     "Prototype sandbox").
--   • `instinct_prototypes` EXISTS as an alias view from migration 014
--     (`CREATE OR REPLACE VIEW instinct_prototypes AS SELECT * FROM
--      apex_prototypes`). That alias view MUST be dropped before the
--     ALTER TABLE RENAME — otherwise `relation already exists` (42P07).
--
--   • No foreign keys reference apex_prototypes (verified via grep for
--     `REFERENCES apex_prototypes` and `FOREIGN KEY.*apex_prototypes`
--     across the full tree — zero hits). No dependent materialized
--     views, triggers, or rules exist.
--
--   • Migration 001 creates TWO secondary indexes on apex_prototypes:
--       idx_apex_prototypes_created_by ON apex_prototypes (created_by)
--       idx_apex_prototypes_status     ON apex_prototypes (status)
--     Both are renamed at the bottom of this file (ALTER INDEX IF EXISTS,
--     idempotent).

BEGIN;

DO $$
DECLARE
  apex_exists_as_table BOOLEAN;
  instinct_kind CHAR;
  pre_rename_count BIGINT := NULL;
  post_rename_count BIGINT;
BEGIN
  -- Does apex_prototypes still exist as a regular table?
  SELECT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'apex_prototypes'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
  ) INTO apex_exists_as_table;

  -- What is instinct_prototypes right now? (NULL = doesn't exist)
  SELECT c.relkind
    INTO instinct_kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_prototypes'
      AND n.nspname = current_schema()
    LIMIT 1;

  -- Snapshot row count BEFORE the rename so we can assert no rows
  -- disappeared after. Use EXECUTE+INTO for dynamic table name.
  IF apex_exists_as_table THEN
    EXECUTE 'SELECT COUNT(*) FROM apex_prototypes' INTO pre_rename_count;
  ELSIF instinct_kind = 'r' THEN
    EXECUTE 'SELECT COUNT(*) FROM instinct_prototypes' INTO pre_rename_count;
  END IF;

  -- =========================================================
  -- Case A: already renamed — instinct is the table.
  --         Ensure the backward-compat view exists so any legacy
  --         apex_prototypes reference still works.
  -- =========================================================
  IF instinct_kind = 'r' AND NOT apex_exists_as_table THEN
    EXECUTE 'CREATE OR REPLACE VIEW apex_prototypes AS SELECT * FROM instinct_prototypes';
    RAISE NOTICE 'Already renamed; ensured compat view apex_prototypes exists.';

  -- =========================================================
  -- Case B: clean pre-rename — apex is the table, instinct is a view
  --         (the migration-014 alias view). Drop the existing
  --         instinct_* alias view, rename the table, create the
  --         reverse compat view.
  -- =========================================================
  ELSIF apex_exists_as_table AND instinct_kind = 'v' THEN
    EXECUTE 'DROP VIEW instinct_prototypes';
    EXECUTE 'ALTER TABLE apex_prototypes RENAME TO instinct_prototypes';
    EXECUTE 'CREATE OR REPLACE VIEW apex_prototypes AS SELECT * FROM instinct_prototypes';
    RAISE NOTICE 'Renamed apex_prototypes → instinct_prototypes; compat view created.';

  -- =========================================================
  -- Case C: pre-rename but the alias view was dropped elsewhere.
  --         Just rename the table + create compat view.
  -- =========================================================
  ELSIF apex_exists_as_table AND instinct_kind IS NULL THEN
    EXECUTE 'ALTER TABLE apex_prototypes RENAME TO instinct_prototypes';
    EXECUTE 'CREATE OR REPLACE VIEW apex_prototypes AS SELECT * FROM instinct_prototypes';
    RAISE NOTICE 'Renamed apex_prototypes → instinct_prototypes (no pre-existing alias view); compat view created.';

  -- =========================================================
  -- Case D: Mystery state — instinct_prototypes exists as something
  --         other than a view or table (materialized view, sequence,
  --         foreign table, composite type, etc.). Abort with a clear
  --         error so a human investigates.
  -- =========================================================
  ELSIF instinct_kind IS NOT NULL AND instinct_kind NOT IN ('r', 'v') THEN
    RAISE EXCEPTION 'Refusing to proceed: instinct_prototypes exists as relkind=% — manual inspection required.', instinct_kind;

  -- =========================================================
  -- Case E: apex_prototypes gone AND instinct_prototypes is a view.
  --         Orphan-view cleanup: drop the view.
  -- =========================================================
  ELSIF NOT apex_exists_as_table AND instinct_kind = 'v' THEN
    EXECUTE 'DROP VIEW instinct_prototypes';
    RAISE NOTICE 'Dropped orphan view instinct_prototypes; apex_prototypes table is absent.';

  -- =========================================================
  -- Case F: neither exists — no-op (migrations 001/014 never ran here).
  -- =========================================================
  ELSE
    RAISE NOTICE 'Neither apex_prototypes nor instinct_prototypes exists; nothing to rename.';
  END IF;

  -- Row-count assertion: if we had a source table, the post-rename
  -- count must match exactly. ALTER TABLE RENAME is metadata-only so
  -- row count is always preserved; any mismatch means the rename did
  -- not happen as expected or the table we landed on is different from
  -- what we started with. Either way, abort.
  IF pre_rename_count IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT COUNT(*) FROM instinct_prototypes' INTO post_rename_count;
    EXCEPTION WHEN undefined_table THEN
      -- Fallback: if nothing was renamed (Case F), skip assertion.
      post_rename_count := NULL;
    END;
    IF post_rename_count IS NOT NULL AND post_rename_count != pre_rename_count THEN
      RAISE EXCEPTION 'Row-count mismatch after rename: pre=% post=% — aborting.', pre_rename_count, post_rename_count;
    END IF;
    RAISE NOTICE 'Row-count assertion passed: % rows preserved.', COALESCE(pre_rename_count, 0);
  END IF;
END $$;

-- Rename the two secondary indexes (idempotent, independent of the block
-- above). Each guarded with IF EXISTS so any partial prior state is
-- tolerated. Migration 001 created:
--   idx_apex_prototypes_created_by ON apex_prototypes (created_by)
--   idx_apex_prototypes_status     ON apex_prototypes (status)
ALTER INDEX IF EXISTS idx_apex_prototypes_created_by RENAME TO idx_instinct_prototypes_created_by;
ALTER INDEX IF EXISTS idx_apex_prototypes_status     RENAME TO idx_instinct_prototypes_status;

-- =========================================================================
-- Compat-view updatability assertion.
--
-- The backward-compat view created above is supposed to be auto-updatable
-- (simple passthrough SELECT * FROM ...) so any legacy code reference
-- INSERTing / UPDATEing / DELETEing via apex_prototypes still propagates
-- to the renamed underlying table.
--
-- If for any reason the view is NOT updatable (Postgres rewriter
-- disagrees about shape, the underlying table has a column we missed,
-- an RLS policy blocks the view path, etc.), this assertion RAISES
-- EXCEPTION and the whole migration is rolled back. No silent
-- write-discard.
-- =========================================================================
DO $$
DECLARE
  is_updatable TEXT;
  is_insertable TEXT;
BEGIN
  -- Only assert if the compat view was actually created (Cases A, B, C).
  -- Cases D, E, F skipped the view creation intentionally.
  IF EXISTS (
    SELECT 1 FROM information_schema.views
    WHERE table_schema = current_schema()
      AND table_name = 'apex_prototypes'
  ) THEN
    SELECT v.is_updatable, v.is_insertable_into
      INTO is_updatable, is_insertable
      FROM information_schema.views v
      WHERE v.table_schema = current_schema()
        AND v.table_name = 'apex_prototypes';

    IF is_updatable != 'YES' THEN
      RAISE EXCEPTION 'Compat view apex_prototypes is NOT updatable (is_updatable=%). Legacy code UPDATEs/DELETEs would silently fail. Aborting.', is_updatable;
    END IF;
    IF is_insertable != 'YES' THEN
      RAISE EXCEPTION 'Compat view apex_prototypes is NOT insertable (is_insertable_into=%). Legacy code INSERTs would silently fail. Aborting.', is_insertable;
    END IF;
    RAISE NOTICE 'Compat view apex_prototypes is fully R/W (is_updatable=%, is_insertable_into=%).', is_updatable, is_insertable;
  END IF;
END $$;

COMMIT;
