-- Tier 4 DB rename batch 5 / stream U2:
--   apex_brief_edit_insights_snapshots → instinct_brief_edit_insights_snapshots
--
-- Sibling migrations in this batch:
--   052 — (sibling rename)   U1
--   053 — (sibling rename)   U3
--   054 — (sibling rename)   U4
--   055 — apex_brief_edit_insights_snapshots → instinct_* (this file, U2)
--   056 — (sibling rename)   U5
--
-- Safety-first design — same structure as 051_rename_user_memory.sql,
-- 046_rename_onboarding_templates.sql, 043_rename_journals.sql, and
-- 036_rename_feature_requests.sql:
--
--   1. DEFENSIVE RENAME — handles any prior state (fresh DB, already-
--      renamed DB, partial-rollback states) so the migration never
--      aborts the deploy.
--
--   2. BACKWARD-COMPAT VIEW — after the rename,
--      `apex_brief_edit_insights_snapshots` becomes an auto-updatable
--      passthrough view to the renamed table. Any missed code
--      reference (SELECT, INSERT, UPDATE, DELETE) still works against
--      the OLD name so data flow never silently drops. The nightly
--      brief-edit insights snapshotter in
--      scripts/brief-edit-insights-nightly.ts INSERTs via
--      writeInsightsSnapshot (src/lib/brief-edit-learning.ts), so the
--      view MUST be insertable or the learning-loop persistence
--      silently breaks.
--
--   3. ROW-COUNT ASSERTION — snapshots COUNT(*) before the rename,
--      compares after, RAISES EXCEPTION if they don't match.
--
-- Starting-state specifics for THIS rename:
--   • `apex_brief_edit_insights_snapshots` is the real table
--     (migration 030). One row per (window_start, window_end) per
--     nightly snapshot run. Pure JSONB payload storage — no FKs in
--     or out of this table. A leaf table.
--
--   • `instinct_brief_edit_insights_snapshots` EXISTS as an alias view
--     created at the END of migration 030
--     (`CREATE OR REPLACE VIEW instinct_brief_edit_insights_snapshots
--      AS SELECT * FROM apex_brief_edit_insights_snapshots`). That
--     alias view MUST be dropped before the ALTER TABLE RENAME —
--     otherwise `relation already exists` (42P07).
--
--   • Migration 030 defines:
--       - PRIMARY KEY on (id) — auto-renamed by ALTER TABLE RENAME.
--       - `idx_brief_edit_snapshots_window_end` ON (window_end)
--         — this index is NOT prefixed with the table name, so it
--         does NOT need to be renamed. We leave it alone.
--
--   • No UNIQUE constraints on this table, so no auto-named composite
--     constraint to chase (unlike migration 051).
--
--   • No aggregate / materialized views reference this table —
--     confirmed by `grep -rn "FROM apex_brief_edit_insights_snapshots"
--     src/db/migrations/` returning only the alias view from 030.

BEGIN;

-- Drop any stale compat view with the old name first so the rename
-- target is free. (Idempotent: harmless no-op if absent.)
DROP VIEW IF EXISTS apex_brief_edit_insights_snapshots_compat;

DO $$
DECLARE
  apex_exists_as_table BOOLEAN;
  instinct_kind CHAR;
  pre_rename_count BIGINT := NULL;
  post_rename_count BIGINT;
BEGIN
  -- Does apex_brief_edit_insights_snapshots still exist as a regular
  -- table?
  SELECT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'apex_brief_edit_insights_snapshots'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
  ) INTO apex_exists_as_table;

  -- What is instinct_brief_edit_insights_snapshots right now?
  -- (NULL = doesn't exist)
  SELECT c.relkind
    INTO instinct_kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_brief_edit_insights_snapshots'
      AND n.nspname = current_schema()
    LIMIT 1;

  -- Snapshot row count BEFORE the rename so we can assert no rows
  -- disappeared after. Use EXECUTE+INTO for dynamic table name.
  IF apex_exists_as_table THEN
    EXECUTE 'SELECT COUNT(*) FROM apex_brief_edit_insights_snapshots'
      INTO pre_rename_count;
  ELSIF instinct_kind = 'r' THEN
    EXECUTE 'SELECT COUNT(*) FROM instinct_brief_edit_insights_snapshots'
      INTO pre_rename_count;
  END IF;

  -- =========================================================
  -- Case A: already renamed — instinct is the table.
  --         Ensure the backward-compat view exists so any legacy
  --         apex_brief_edit_insights_snapshots reference still works.
  -- =========================================================
  IF instinct_kind = 'r' AND NOT apex_exists_as_table THEN
    EXECUTE 'CREATE OR REPLACE VIEW apex_brief_edit_insights_snapshots '
         || 'AS SELECT * FROM instinct_brief_edit_insights_snapshots';
    RAISE NOTICE 'Already renamed; ensured compat view apex_brief_edit_insights_snapshots exists.';

  -- =========================================================
  -- Case B: clean pre-rename — apex is the table, instinct is a view
  --         (the migration-030 alias view). Drop the existing
  --         instinct_* alias view, rename the table, create the
  --         reverse compat view.
  -- =========================================================
  ELSIF apex_exists_as_table AND instinct_kind = 'v' THEN
    EXECUTE 'DROP VIEW instinct_brief_edit_insights_snapshots';
    EXECUTE 'ALTER TABLE apex_brief_edit_insights_snapshots '
         || 'RENAME TO instinct_brief_edit_insights_snapshots';
    EXECUTE 'CREATE OR REPLACE VIEW apex_brief_edit_insights_snapshots '
         || 'AS SELECT * FROM instinct_brief_edit_insights_snapshots';
    RAISE NOTICE 'Renamed apex_brief_edit_insights_snapshots → instinct_brief_edit_insights_snapshots; compat view created.';

  -- =========================================================
  -- Case C: pre-rename but the alias view was dropped elsewhere.
  --         Just rename the table + create compat view.
  -- =========================================================
  ELSIF apex_exists_as_table AND instinct_kind IS NULL THEN
    EXECUTE 'ALTER TABLE apex_brief_edit_insights_snapshots '
         || 'RENAME TO instinct_brief_edit_insights_snapshots';
    EXECUTE 'CREATE OR REPLACE VIEW apex_brief_edit_insights_snapshots '
         || 'AS SELECT * FROM instinct_brief_edit_insights_snapshots';
    RAISE NOTICE 'Renamed apex_brief_edit_insights_snapshots → instinct_brief_edit_insights_snapshots (no pre-existing alias view); compat view created.';

  -- =========================================================
  -- Case D: Mystery state — instinct_brief_edit_insights_snapshots
  --         exists as something other than a view or table
  --         (materialized view, sequence, foreign table, composite
  --         type, etc.). Abort with a clear error.
  -- =========================================================
  ELSIF instinct_kind IS NOT NULL AND instinct_kind NOT IN ('r', 'v') THEN
    RAISE EXCEPTION 'Refusing to proceed: instinct_brief_edit_insights_snapshots exists as relkind=% — manual inspection required.', instinct_kind;

  -- =========================================================
  -- Case E: apex gone AND instinct is a view.
  --         Orphan-view cleanup: drop the view.
  -- =========================================================
  ELSIF NOT apex_exists_as_table AND instinct_kind = 'v' THEN
    EXECUTE 'DROP VIEW instinct_brief_edit_insights_snapshots';
    RAISE NOTICE 'Dropped orphan view instinct_brief_edit_insights_snapshots; apex_brief_edit_insights_snapshots table is absent.';

  -- =========================================================
  -- Case F: neither exists — no-op (migration 030 never ran here).
  -- =========================================================
  ELSE
    RAISE NOTICE 'Neither apex_brief_edit_insights_snapshots nor instinct_brief_edit_insights_snapshots exists; nothing to rename.';
  END IF;

  -- Row-count assertion: if we had a source table, the post-rename
  -- count must match exactly. ALTER TABLE RENAME is metadata-only so
  -- row count is always preserved; any mismatch means the rename did
  -- not happen as expected or the table we landed on is different
  -- from what we started with. Either way, abort.
  IF pre_rename_count IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT COUNT(*) FROM instinct_brief_edit_insights_snapshots'
        INTO post_rename_count;
    EXCEPTION WHEN undefined_table THEN
      post_rename_count := NULL;
    END;
    IF post_rename_count IS NOT NULL AND post_rename_count != pre_rename_count THEN
      RAISE EXCEPTION 'Row-count mismatch after rename: pre=% post=% — aborting.', pre_rename_count, post_rename_count;
    END IF;
    RAISE NOTICE 'Row-count assertion passed: % rows preserved.', COALESCE(pre_rename_count, 0);
  END IF;
END $$;

-- Note on indexes: migration 030 created
--   idx_brief_edit_snapshots_window_end ON apex_brief_edit_insights_snapshots(window_end)
-- The index name does NOT embed the old `apex_` table prefix, so no
-- rename is needed. Leaving it in place avoids needless churn.
--
-- Note on constraints: no UNIQUE constraints on this table — only the
-- implicit PRIMARY KEY on (id), auto-renamed by ALTER TABLE RENAME.

-- =========================================================================
-- Compat-view updatability assertion.
--
-- The backward-compat view created above is supposed to be auto-
-- updatable (simple passthrough SELECT * FROM ...) so any legacy code
-- reference INSERTing / UPDATEing / DELETEing via
-- apex_brief_edit_insights_snapshots still propagates to the renamed
-- underlying table.
--
-- Specifically, writeInsightsSnapshot() in src/lib/brief-edit-learning.ts
-- INSERTs into apex_brief_edit_insights_snapshots. If this view were
-- NOT insertable, the nightly brief-edit snapshot job would 200-
-- silently-discard and we'd lose the learning loop's memory — exactly
-- the failure mode feedback_no_silent_data_loss.md warns against.
-- =========================================================================
DO $$
DECLARE
  is_updatable TEXT;
  is_insertable TEXT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.views
    WHERE table_schema = current_schema()
      AND table_name = 'apex_brief_edit_insights_snapshots'
  ) THEN
    SELECT v.is_updatable, v.is_insertable_into
      INTO is_updatable, is_insertable
      FROM information_schema.views v
      WHERE v.table_schema = current_schema()
        AND v.table_name = 'apex_brief_edit_insights_snapshots';

    IF is_updatable != 'YES' THEN
      RAISE EXCEPTION 'Compat view apex_brief_edit_insights_snapshots is NOT updatable (is_updatable=%). Legacy code UPDATEs/DELETEs would silently fail. Aborting.', is_updatable;
    END IF;
    IF is_insertable != 'YES' THEN
      RAISE EXCEPTION 'Compat view apex_brief_edit_insights_snapshots is NOT insertable (is_insertable_into=%). The nightly brief-edit insights snapshot job would silently discard. Aborting.', is_insertable;
    END IF;
    RAISE NOTICE 'Compat view apex_brief_edit_insights_snapshots is fully R/W (is_updatable=%, is_insertable_into=%).', is_updatable, is_insertable;
  END IF;
END $$;

COMMIT;
