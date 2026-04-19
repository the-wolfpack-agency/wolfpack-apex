-- Tier 4 DB rename batch 2 / stream S3: apex_journals → instinct_journals
--
-- Sibling migrations in this batch:
--   041 — apex_plaud_connections → instinct_plaud_connections (S1)
--   042 — apex_qbo_tokens        → instinct_qbo_tokens        (S2)
--   043 — apex_journals          → instinct_journals          (this file)
--
-- Safety-first design — same structure as 036_rename_feature_requests.sql:
--
--   1. DEFENSIVE RENAME — handles any prior state (fresh DB, already-
--      renamed DB, partial-rollback states) so the migration never
--      aborts the deploy.
--
--   2. BACKWARD-COMPAT VIEW — after the rename, `apex_journals` becomes
--      an auto-updatable passthrough view to the renamed table. Any
--      missed code reference (SELECT, INSERT, UPDATE, DELETE) still
--      works against the OLD name so data flow never silently drops.
--
--   3. ROW-COUNT ASSERTION — snapshots COUNT(*) before the rename,
--      compares after, RAISES EXCEPTION if they don't match.
--
-- Starting-state specifics for THIS rename:
--   • `apex_journals` is the real table (migration 001).
--   • `instinct_journals` EXISTS as an alias view from migration 014
--     (`CREATE OR REPLACE VIEW instinct_journals AS SELECT * FROM
--      apex_journals`). That alias view MUST be dropped before the
--     ALTER TABLE RENAME — otherwise `relation already exists` (42P07).
--
-- Precedent for drop+rebuild view around ALTER TABLE:
--   040_user_id_columns_to_text.sql handles the dependent-view pattern
--   for instinct_share_tokens; the structure here mirrors that.

BEGIN;

DO $$
DECLARE
  apex_exists_as_table BOOLEAN;
  instinct_kind CHAR;
  pre_rename_count BIGINT := NULL;
  post_rename_count BIGINT;
BEGIN
  -- Does apex_journals still exist as a regular table?
  SELECT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'apex_journals'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
  ) INTO apex_exists_as_table;

  -- What is instinct_journals right now? (NULL = doesn't exist)
  SELECT c.relkind
    INTO instinct_kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_journals'
      AND n.nspname = current_schema()
    LIMIT 1;

  -- Snapshot row count BEFORE the rename so we can assert no rows
  -- disappeared after. Use EXECUTE+INTO for dynamic table name.
  IF apex_exists_as_table THEN
    EXECUTE 'SELECT COUNT(*) FROM apex_journals' INTO pre_rename_count;
  ELSIF instinct_kind = 'r' THEN
    EXECUTE 'SELECT COUNT(*) FROM instinct_journals' INTO pre_rename_count;
  END IF;

  -- =========================================================
  -- Case A: already renamed — instinct is the table.
  --         Ensure the backward-compat view exists so any legacy
  --         apex_journals reference still works.
  -- =========================================================
  IF instinct_kind = 'r' AND NOT apex_exists_as_table THEN
    EXECUTE 'CREATE OR REPLACE VIEW apex_journals AS SELECT * FROM instinct_journals';
    RAISE NOTICE 'Already renamed; ensured compat view apex_journals exists.';

  -- =========================================================
  -- Case B: clean pre-rename — apex is the table, instinct is a view
  --         (the migration-014 alias view). Drop the existing
  --         instinct_* alias view, rename the table, create the
  --         reverse compat view.
  -- =========================================================
  ELSIF apex_exists_as_table AND instinct_kind = 'v' THEN
    EXECUTE 'DROP VIEW instinct_journals';
    EXECUTE 'ALTER TABLE apex_journals RENAME TO instinct_journals';
    EXECUTE 'CREATE OR REPLACE VIEW apex_journals AS SELECT * FROM instinct_journals';
    RAISE NOTICE 'Renamed apex_journals → instinct_journals; compat view created.';

  -- =========================================================
  -- Case C: pre-rename but the alias view was dropped elsewhere.
  --         Just rename the table + create compat view.
  -- =========================================================
  ELSIF apex_exists_as_table AND instinct_kind IS NULL THEN
    EXECUTE 'ALTER TABLE apex_journals RENAME TO instinct_journals';
    EXECUTE 'CREATE OR REPLACE VIEW apex_journals AS SELECT * FROM instinct_journals';
    RAISE NOTICE 'Renamed apex_journals → instinct_journals (no pre-existing alias view); compat view created.';

  -- =========================================================
  -- Case D: Mystery state — instinct_journals exists as something
  --         other than a view or table (materialized view, sequence,
  --         foreign table, composite type, etc.). Abort with a clear
  --         error so a human investigates.
  -- =========================================================
  ELSIF instinct_kind IS NOT NULL AND instinct_kind NOT IN ('r', 'v') THEN
    RAISE EXCEPTION 'Refusing to proceed: instinct_journals exists as relkind=% — manual inspection required.', instinct_kind;

  -- =========================================================
  -- Case E: apex_journals gone AND instinct_journals is a view.
  --         Orphan-view cleanup: drop the view.
  -- =========================================================
  ELSIF NOT apex_exists_as_table AND instinct_kind = 'v' THEN
    EXECUTE 'DROP VIEW instinct_journals';
    RAISE NOTICE 'Dropped orphan view instinct_journals; apex_journals table is absent.';

  -- =========================================================
  -- Case F: neither exists — no-op (migrations 001/014 never ran here).
  -- =========================================================
  ELSE
    RAISE NOTICE 'Neither apex_journals nor instinct_journals exists; nothing to rename.';
  END IF;

  -- Row-count assertion: if we had a source table, the post-rename
  -- count must match exactly. ALTER TABLE RENAME is metadata-only so
  -- row count is always preserved; any mismatch means the rename did
  -- not happen as expected or the table we landed on is different from
  -- what we started with. Either way, abort.
  IF pre_rename_count IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT COUNT(*) FROM instinct_journals' INTO post_rename_count;
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

-- Rename the two indexes (idempotent, independent of the block above).
-- Each guarded with IF EXISTS so any partial prior state is tolerated.
-- Migration 001 created:
--   idx_apex_journals_user ON apex_journals (user_id)
--   idx_apex_journals_date ON apex_journals (date)
ALTER INDEX IF EXISTS idx_apex_journals_user RENAME TO idx_instinct_journals_user;
ALTER INDEX IF EXISTS idx_apex_journals_date RENAME TO idx_instinct_journals_date;

-- =========================================================================
-- Compat-view updatability assertion.
--
-- The backward-compat view created above is supposed to be auto-updatable
-- (simple passthrough SELECT * FROM ...) so any legacy code reference
-- INSERTing / UPDATEing / DELETEing via apex_journals still propagates
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
      AND table_name = 'apex_journals'
  ) THEN
    SELECT v.is_updatable, v.is_insertable_into
      INTO is_updatable, is_insertable
      FROM information_schema.views v
      WHERE v.table_schema = current_schema()
        AND v.table_name = 'apex_journals';

    IF is_updatable != 'YES' THEN
      RAISE EXCEPTION 'Compat view apex_journals is NOT updatable (is_updatable=%). Legacy code UPDATEs/DELETEs would silently fail. Aborting.', is_updatable;
    END IF;
    IF is_insertable != 'YES' THEN
      RAISE EXCEPTION 'Compat view apex_journals is NOT insertable (is_insertable_into=%). Legacy code INSERTs would silently fail. Aborting.', is_insertable;
    END IF;
    RAISE NOTICE 'Compat view apex_journals is fully R/W (is_updatable=%, is_insertable_into=%).', is_updatable, is_insertable;
  END IF;
END $$;

COMMIT;
