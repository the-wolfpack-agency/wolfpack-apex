-- Tier 4 DB rename batch 4 / stream U4: apex_user_memory → instinct_user_memory
--
-- Sibling migrations in this batch:
--   048 — apex_onboarding_instances   → instinct_onboarding_instances   (U1)
--   049 — apex_prototypes             → instinct_prototypes             (U2)
--   050 — apex_meeting_transcripts    → instinct_meeting_transcripts    (U3)
--   051 — apex_user_memory            → instinct_user_memory            (this file)
--
-- Safety-first design — same structure as 036_rename_feature_requests.sql,
-- 043_rename_journals.sql, and 046_rename_onboarding_templates.sql:
--
--   1. DEFENSIVE RENAME — handles any prior state (fresh DB, already-
--      renamed DB, partial-rollback states) so the migration never
--      aborts the deploy.
--
--   2. BACKWARD-COMPAT VIEW — after the rename, `apex_user_memory`
--      becomes an auto-updatable passthrough view to the renamed table.
--      Any missed code reference (SELECT, INSERT, UPDATE, DELETE) still
--      works against the OLD name so data flow never silently drops.
--
--   3. ROW-COUNT ASSERTION — snapshots COUNT(*) before the rename,
--      compares after, RAISES EXCEPTION if they don't match.
--
-- Starting-state specifics for THIS rename:
--   • `apex_user_memory` is the real table (migration 003). It stores
--     per-member persistent context — preferences, expertise, topics,
--     instructions — keyed by (user_id, memory_type, key).
--
--   • `instinct_user_memory` EXISTS as an alias view from migration 014
--     (`CREATE OR REPLACE VIEW instinct_user_memory AS SELECT * FROM
--      apex_user_memory`). That alias view MUST be dropped before the
--     ALTER TABLE RENAME — otherwise `relation already exists` (42P07).
--
--   • Migration 003 defines:
--       - PRIMARY KEY on (id) — auto-renamed by ALTER TABLE RENAME.
--       - UNIQUE (user_id, memory_type, key) — auto-named
--         `apex_user_memory_user_id_memory_type_key_key` by Postgres.
--         The constraint name and its backing index stay put across
--         ALTER TABLE RENAME (Postgres renames tables, not constraint
--         metadata strings). We explicitly rename both for hygiene and
--         so anyone inspecting `\d instinct_user_memory` sees
--         consistent names. The ON CONFLICT (user_id, memory_type, key)
--         clause in src/lib/assistant.ts resolves the constraint by
--         column tuple, so its semantics survive either way — the
--         rename is purely cosmetic.
--       - `idx_apex_user_memory_user` ON (user_id)
--       - `idx_apex_user_memory_type` ON (user_id, memory_type)
--
--   • No foreign keys in or out of this table — apex_user_memory is a
--     leaf. Nothing references it, and user_id is a free-form TEXT
--     (matches the post-040 convention for user-id columns).
--
--   • No dependent views beyond the migration-014 alias — confirmed
--     by `grep -rnE "FROM apex_user_memory|VIEW .*user_memory"
--     src/db/migrations/`.

BEGIN;

DO $$
DECLARE
  apex_exists_as_table BOOLEAN;
  instinct_kind CHAR;
  pre_rename_count BIGINT := NULL;
  post_rename_count BIGINT;
BEGIN
  -- Does apex_user_memory still exist as a regular table?
  SELECT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'apex_user_memory'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
  ) INTO apex_exists_as_table;

  -- What is instinct_user_memory right now? (NULL = doesn't exist)
  SELECT c.relkind
    INTO instinct_kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_user_memory'
      AND n.nspname = current_schema()
    LIMIT 1;

  -- Snapshot row count BEFORE the rename so we can assert no rows
  -- disappeared after. Use EXECUTE+INTO for dynamic table name.
  IF apex_exists_as_table THEN
    EXECUTE 'SELECT COUNT(*) FROM apex_user_memory' INTO pre_rename_count;
  ELSIF instinct_kind = 'r' THEN
    EXECUTE 'SELECT COUNT(*) FROM instinct_user_memory' INTO pre_rename_count;
  END IF;

  -- =========================================================
  -- Case A: already renamed — instinct is the table.
  --         Ensure the backward-compat view exists so any legacy
  --         apex_user_memory reference still works.
  -- =========================================================
  IF instinct_kind = 'r' AND NOT apex_exists_as_table THEN
    EXECUTE 'CREATE OR REPLACE VIEW apex_user_memory AS SELECT * FROM instinct_user_memory';
    RAISE NOTICE 'Already renamed; ensured compat view apex_user_memory exists.';

  -- =========================================================
  -- Case B: clean pre-rename — apex is the table, instinct is a view
  --         (the migration-014 alias view). Drop the existing
  --         instinct_* alias view, rename the table, create the
  --         reverse compat view.
  -- =========================================================
  ELSIF apex_exists_as_table AND instinct_kind = 'v' THEN
    EXECUTE 'DROP VIEW instinct_user_memory';
    EXECUTE 'ALTER TABLE apex_user_memory RENAME TO instinct_user_memory';
    EXECUTE 'CREATE OR REPLACE VIEW apex_user_memory AS SELECT * FROM instinct_user_memory';
    RAISE NOTICE 'Renamed apex_user_memory → instinct_user_memory; compat view created.';

  -- =========================================================
  -- Case C: pre-rename but the alias view was dropped elsewhere.
  --         Just rename the table + create compat view.
  -- =========================================================
  ELSIF apex_exists_as_table AND instinct_kind IS NULL THEN
    EXECUTE 'ALTER TABLE apex_user_memory RENAME TO instinct_user_memory';
    EXECUTE 'CREATE OR REPLACE VIEW apex_user_memory AS SELECT * FROM instinct_user_memory';
    RAISE NOTICE 'Renamed apex_user_memory → instinct_user_memory (no pre-existing alias view); compat view created.';

  -- =========================================================
  -- Case D: Mystery state — instinct_user_memory exists as something
  --         other than a view or table (materialized view, sequence,
  --         foreign table, composite type, etc.). Abort with a clear
  --         error so a human investigates.
  -- =========================================================
  ELSIF instinct_kind IS NOT NULL AND instinct_kind NOT IN ('r', 'v') THEN
    RAISE EXCEPTION 'Refusing to proceed: instinct_user_memory exists as relkind=% — manual inspection required.', instinct_kind;

  -- =========================================================
  -- Case E: apex_user_memory gone AND instinct_user_memory is a view.
  --         Orphan-view cleanup: drop the view.
  -- =========================================================
  ELSIF NOT apex_exists_as_table AND instinct_kind = 'v' THEN
    EXECUTE 'DROP VIEW instinct_user_memory';
    RAISE NOTICE 'Dropped orphan view instinct_user_memory; apex_user_memory table is absent.';

  -- =========================================================
  -- Case F: neither exists — no-op (migrations 003/014 never ran here).
  -- =========================================================
  ELSE
    RAISE NOTICE 'Neither apex_user_memory nor instinct_user_memory exists; nothing to rename.';
  END IF;

  -- Row-count assertion: if we had a source table, the post-rename
  -- count must match exactly. ALTER TABLE RENAME is metadata-only so
  -- row count is always preserved; any mismatch means the rename did
  -- not happen as expected or the table we landed on is different from
  -- what we started with. Either way, abort.
  IF pre_rename_count IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT COUNT(*) FROM instinct_user_memory' INTO post_rename_count;
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

-- Rename secondary indexes (idempotent, independent of the block above).
-- Each guarded with IF EXISTS so any partial prior state is tolerated.
-- Migration 003 created:
--   idx_apex_user_memory_user ON apex_user_memory (user_id)
--   idx_apex_user_memory_type ON apex_user_memory (user_id, memory_type)
ALTER INDEX IF EXISTS idx_apex_user_memory_user RENAME TO idx_instinct_user_memory_user;
ALTER INDEX IF EXISTS idx_apex_user_memory_type RENAME TO idx_instinct_user_memory_type;

-- Rename the auto-named composite UNIQUE constraint + its backing index.
-- Postgres generated the constraint name `apex_user_memory_user_id_memory_type_key_key`
-- from the `UNIQUE (user_id, memory_type, key)` declaration in migration 003
-- (table + column list + `_key` suffix). ALTER TABLE RENAME does NOT rewrite
-- constraint names — they persist until explicitly renamed.
--
-- The backing unique index shares the same name. We rename both so that
-- `\d instinct_user_memory` and error messages mentioning the constraint
-- show the new prefix consistently. Each guarded with IF EXISTS / DO block
-- so fresh DBs, partial-rollback states, and already-renamed states all
-- land on the same final shape.
DO $$
BEGIN
  -- Constraint rename (semantics: ON CONFLICT (user_id, memory_type, key)
  -- continues to resolve via the same column tuple regardless of name).
  IF EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'apex_user_memory_user_id_memory_type_key_key'
      AND n.nspname = current_schema()
  ) THEN
    EXECUTE 'ALTER TABLE instinct_user_memory '
         || 'RENAME CONSTRAINT apex_user_memory_user_id_memory_type_key_key '
         || 'TO instinct_user_memory_user_id_memory_type_key_key';
    RAISE NOTICE 'Renamed UNIQUE constraint apex_user_memory_user_id_memory_type_key_key.';
  END IF;
END $$;

-- Rename the backing index for the UNIQUE constraint (constraint rename
-- in Postgres renames the index automatically in modern versions, but we
-- keep an explicit guarded fallback for older server versions and for any
-- partial state where the constraint was dropped but the index remained).
ALTER INDEX IF EXISTS apex_user_memory_user_id_memory_type_key_key
  RENAME TO instinct_user_memory_user_id_memory_type_key_key;

-- =========================================================================
-- Compat-view updatability assertion.
--
-- The backward-compat view created above is supposed to be auto-updatable
-- (simple passthrough SELECT * FROM ...) so any legacy code reference
-- INSERTing / UPDATEing / DELETEing via apex_user_memory still propagates
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
      AND table_name = 'apex_user_memory'
  ) THEN
    SELECT v.is_updatable, v.is_insertable_into
      INTO is_updatable, is_insertable
      FROM information_schema.views v
      WHERE v.table_schema = current_schema()
        AND v.table_name = 'apex_user_memory';

    IF is_updatable != 'YES' THEN
      RAISE EXCEPTION 'Compat view apex_user_memory is NOT updatable (is_updatable=%). Legacy code UPDATEs/DELETEs would silently fail. Aborting.', is_updatable;
    END IF;
    IF is_insertable != 'YES' THEN
      RAISE EXCEPTION 'Compat view apex_user_memory is NOT insertable (is_insertable_into=%). Legacy code INSERTs would silently fail. Aborting.', is_insertable;
    END IF;
    RAISE NOTICE 'Compat view apex_user_memory is fully R/W (is_updatable=%, is_insertable_into=%).', is_updatable, is_insertable;
  END IF;
END $$;

COMMIT;
