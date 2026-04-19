-- Tier 4 DB rename batch 5 / stream U4: apex_clients → instinct_clients
--
-- Sibling migrations in this batch (parallel streams, disjoint tables):
--   054 — stream U0
--   055 — stream U1
--   056 — stream U2
--   057 — stream U3
--   058 — apex_clients → instinct_clients (this file, U4)
--
-- Safety-first design — same structure as 049_rename_prototypes.sql and
-- 051_rename_user_memory.sql:
--
--   1. DEFENSIVE RENAME — handles any prior state (fresh DB, already-
--      renamed DB, partial-rollback states) so the migration never
--      aborts the deploy.
--
--   2. BACKWARD-COMPAT VIEW — after the rename, `apex_clients` becomes
--      an auto-updatable passthrough view to the renamed table. Any
--      missed code reference (SELECT, INSERT, UPDATE, DELETE) still works
--      against the OLD name so data flow never silently drops.
--
--   3. ROW-COUNT ASSERTION — snapshots COUNT(*) before the rename,
--      compares after, RAISES EXCEPTION if they don't match.
--
-- Starting-state specifics for THIS rename:
--   • `apex_clients` is the real table (migration 001, section 9
--     "Client context"). It stores client company records — name,
--     industry, contact info, linked docs (JSONB).
--
--   • `instinct_clients` EXISTS as an alias view from migration 014
--     (`CREATE OR REPLACE VIEW instinct_clients AS SELECT * FROM
--      apex_clients`). That alias view MUST be dropped before the
--     ALTER TABLE RENAME — otherwise `relation already exists` (42P07).
--
--   • No foreign keys reference apex_clients (verified via grep for
--     `REFERENCES apex_clients` and `FOREIGN KEY.*apex_clients`
--     across src/db/migrations/ — zero hits). No dependent materialized
--     views, triggers, or rules exist.
--
--   • No aggregate views select from apex_clients (verified via grep
--     `CREATE (MATERIALIZED )?VIEW` followed by `apex_clients` across
--     all migrations — only the migration-014 alias view).
--     Note: `src/lib/morning-briefing.ts` runs a JOIN between
--     apex_clients and apex_events at RUNTIME (not as a persistent
--     view), so no schema-level drop/rebuild is required here — the
--     code reference is updated below to the new table name.
--
--   • Migration 001 creates ONE secondary index on apex_clients:
--       idx_apex_clients_name ON apex_clients USING GIN (name gin_trgm_ops)
--     Renamed at the bottom of this file (ALTER INDEX IF EXISTS,
--     idempotent).

BEGIN;

DO $$
DECLARE
  apex_exists_as_table BOOLEAN;
  instinct_kind CHAR;
  pre_rename_count BIGINT := NULL;
  post_rename_count BIGINT;
BEGIN
  -- Does apex_clients still exist as a regular table?
  SELECT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'apex_clients'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
  ) INTO apex_exists_as_table;

  -- What is instinct_clients right now? (NULL = doesn't exist)
  SELECT c.relkind
    INTO instinct_kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_clients'
      AND n.nspname = current_schema()
    LIMIT 1;

  -- Snapshot row count BEFORE the rename so we can assert no rows
  -- disappeared after. Use EXECUTE+INTO for dynamic table name.
  IF apex_exists_as_table THEN
    EXECUTE 'SELECT COUNT(*) FROM apex_clients' INTO pre_rename_count;
  ELSIF instinct_kind = 'r' THEN
    EXECUTE 'SELECT COUNT(*) FROM instinct_clients' INTO pre_rename_count;
  END IF;

  -- =========================================================
  -- Case A: already renamed — instinct is the table.
  --         Ensure the backward-compat view exists so any legacy
  --         apex_clients reference still works.
  -- =========================================================
  IF instinct_kind = 'r' AND NOT apex_exists_as_table THEN
    EXECUTE 'CREATE OR REPLACE VIEW apex_clients AS SELECT * FROM instinct_clients';
    RAISE NOTICE 'Already renamed; ensured compat view apex_clients exists.';

  -- =========================================================
  -- Case B: clean pre-rename — apex is the table, instinct is a view
  --         (the migration-014 alias view). Drop the existing
  --         instinct_* alias view, rename the table, create the
  --         reverse compat view.
  -- =========================================================
  ELSIF apex_exists_as_table AND instinct_kind = 'v' THEN
    EXECUTE 'DROP VIEW instinct_clients';
    EXECUTE 'ALTER TABLE apex_clients RENAME TO instinct_clients';
    EXECUTE 'CREATE OR REPLACE VIEW apex_clients AS SELECT * FROM instinct_clients';
    RAISE NOTICE 'Renamed apex_clients → instinct_clients; compat view created.';

  -- =========================================================
  -- Case C: pre-rename but the alias view was dropped elsewhere.
  --         Just rename the table + create compat view.
  -- =========================================================
  ELSIF apex_exists_as_table AND instinct_kind IS NULL THEN
    EXECUTE 'ALTER TABLE apex_clients RENAME TO instinct_clients';
    EXECUTE 'CREATE OR REPLACE VIEW apex_clients AS SELECT * FROM instinct_clients';
    RAISE NOTICE 'Renamed apex_clients → instinct_clients (no pre-existing alias view); compat view created.';

  -- =========================================================
  -- Case D: Mystery state — instinct_clients exists as something
  --         other than a view or table (materialized view, sequence,
  --         foreign table, composite type, etc.). Abort with a clear
  --         error so a human investigates.
  -- =========================================================
  ELSIF instinct_kind IS NOT NULL AND instinct_kind NOT IN ('r', 'v') THEN
    RAISE EXCEPTION 'Refusing to proceed: instinct_clients exists as relkind=% — manual inspection required.', instinct_kind;

  -- =========================================================
  -- Case E: apex_clients gone AND instinct_clients is a view.
  --         Orphan-view cleanup: drop the view.
  -- =========================================================
  ELSIF NOT apex_exists_as_table AND instinct_kind = 'v' THEN
    EXECUTE 'DROP VIEW instinct_clients';
    RAISE NOTICE 'Dropped orphan view instinct_clients; apex_clients table is absent.';

  -- =========================================================
  -- Case F: neither exists — no-op (migrations 001/014 never ran here).
  -- =========================================================
  ELSE
    RAISE NOTICE 'Neither apex_clients nor instinct_clients exists; nothing to rename.';
  END IF;

  -- Row-count assertion: if we had a source table, the post-rename
  -- count must match exactly. ALTER TABLE RENAME is metadata-only so
  -- row count is always preserved; any mismatch means the rename did
  -- not happen as expected or the table we landed on is different from
  -- what we started with. Either way, abort.
  IF pre_rename_count IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT COUNT(*) FROM instinct_clients' INTO post_rename_count;
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

-- Rename the GIN trigram index on the `name` column (idempotent,
-- independent of the block above). Guarded with IF EXISTS so any
-- partial prior state is tolerated. Migration 001 created:
--   idx_apex_clients_name ON apex_clients USING GIN (name gin_trgm_ops)
ALTER INDEX IF EXISTS idx_apex_clients_name RENAME TO idx_instinct_clients_name;

-- =========================================================================
-- Compat-view updatability assertion.
--
-- The backward-compat view created above is supposed to be auto-updatable
-- (simple passthrough SELECT * FROM ...) so any legacy code reference
-- INSERTing / UPDATEing / DELETEing via apex_clients still propagates
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
      AND table_name = 'apex_clients'
  ) THEN
    SELECT v.is_updatable, v.is_insertable_into
      INTO is_updatable, is_insertable
      FROM information_schema.views v
      WHERE v.table_schema = current_schema()
        AND v.table_name = 'apex_clients';

    IF is_updatable != 'YES' THEN
      RAISE EXCEPTION 'Compat view apex_clients is NOT updatable (is_updatable=%). Legacy code UPDATEs/DELETEs would silently fail. Aborting.', is_updatable;
    END IF;
    IF is_insertable != 'YES' THEN
      RAISE EXCEPTION 'Compat view apex_clients is NOT insertable (is_insertable_into=%). Legacy code INSERTs would silently fail. Aborting.', is_insertable;
    END IF;
    RAISE NOTICE 'Compat view apex_clients is fully R/W (is_updatable=%, is_insertable_into=%).', is_updatable, is_insertable;
  END IF;
END $$;

COMMIT;
