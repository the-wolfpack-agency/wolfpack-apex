-- Tier 4 DB rename batch 3 / stream T1: apex_ms_tokens → instinct_ms_tokens
--
-- Sibling migrations in this batch:
--   044 — apex_ms_tokens            → instinct_ms_tokens           (this file, T1)
--   045 — apex_hr_insights          → instinct_hr_insights         (T2)
--   046 — apex_onboarding_templates → instinct_onboarding_templates (T3)
--   047 — apex_qbo_tokens UNIQUE-constraint fix on realm_id         (T4)
--
-- Safety-first design — same structure as 036_rename_feature_requests.sql
-- and 042_rename_qbo_tokens.sql (token-storage precedent):
--
--   1. DEFENSIVE RENAME — handles any prior state (fresh DB, already-
--      renamed DB, partial-rollback states) so the migration never
--      aborts the deploy.
--
--   2. BACKWARD-COMPAT VIEW — after the rename, `apex_ms_tokens` becomes
--      an auto-updatable passthrough view to the renamed table. Any
--      missed code reference (SELECT, INSERT, UPDATE, DELETE) still
--      works against the OLD name so data flow never silently drops.
--      The compat view is removed in a follow-up migration once we've
--      verified every reference is updated.
--
--   3. ROW-COUNT ASSERTION — snapshots COUNT(*) before the rename,
--      compares after, RAISES EXCEPTION if they don't match. ALTER
--      TABLE RENAME is metadata-only so counts MUST match; if they
--      don't, something is catastrophically wrong and we abort the
--      entire transaction (everything rolls back).
--
--   4. VIEW DEPENDENCY — migration 014 created an alias view
--      `instinct_ms_tokens` as SELECT * FROM apex_ms_tokens. Postgres's
--      dependency tracker forbids renaming a table that a view depends
--      on (the view's SELECT list is pinned to the OLD table name).
--      Case B below drops the alias view BEFORE the ALTER TABLE RENAME,
--      then re-creates the reverse compat view
--      (apex_ms_tokens → instinct_ms_tokens) after.
--
-- Starting-state specifics for THIS rename:
--   • `apex_ms_tokens` is the real table (migration 005, per-user
--     unique constraint added by migration 006).
--   • `instinct_ms_tokens` EXISTS as an alias view from migration 014
--     (`CREATE OR REPLACE VIEW instinct_ms_tokens AS SELECT * FROM
--      apex_ms_tokens`). Case B drops that alias view first.
--
-- SECURITY CONTEXT: this table stores Microsoft Graph OAuth2 access +
-- refresh tokens. Silent write-discard on any path would force every
-- connected user to re-OAuth — a visible customer-facing failure. The
-- compat-view updatability assertion below is NON-NEGOTIABLE: if for
-- any reason the passthrough view would silently drop writes, we abort
-- the transaction. Same posture as 042_rename_qbo_tokens.sql.
--
-- Column-type safety: apex_ms_tokens uses `connected_by TEXT`. There
-- are NO UUID user-id columns on this table, so the schema invariant
-- test (src/db/__tests__/user-id-columns-schema.test.ts) cannot trip.
--
-- FK safety: no other table has a FOREIGN KEY referencing apex_ms_tokens.
-- ALTER TABLE RENAME therefore touches only this table's catalog rows.

BEGIN;

DO $$
DECLARE
  apex_exists_as_table BOOLEAN;
  instinct_kind CHAR;
  pre_rename_count BIGINT := NULL;
  post_rename_count BIGINT;
BEGIN
  -- Does apex_ms_tokens still exist as a regular table?
  SELECT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'apex_ms_tokens'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
  ) INTO apex_exists_as_table;

  -- What is instinct_ms_tokens right now? (NULL = doesn't exist)
  SELECT c.relkind
    INTO instinct_kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_ms_tokens'
      AND n.nspname = current_schema()
    LIMIT 1;

  -- Snapshot row count BEFORE the rename so we can assert no rows
  -- disappeared after. Use EXECUTE+INTO for dynamic table name.
  IF apex_exists_as_table THEN
    EXECUTE 'SELECT COUNT(*) FROM apex_ms_tokens' INTO pre_rename_count;
  ELSIF instinct_kind = 'r' THEN
    EXECUTE 'SELECT COUNT(*) FROM instinct_ms_tokens' INTO pre_rename_count;
  END IF;

  -- =========================================================
  -- Case A: already renamed — instinct is the table.
  --         Ensure the backward-compat view exists so any legacy
  --         apex_ms_tokens reference still works.
  -- =========================================================
  IF instinct_kind = 'r' AND NOT apex_exists_as_table THEN
    EXECUTE 'CREATE OR REPLACE VIEW apex_ms_tokens AS SELECT * FROM instinct_ms_tokens';
    RAISE NOTICE 'Already renamed; ensured compat view apex_ms_tokens exists.';

  -- =========================================================
  -- Case B: clean pre-rename — apex is the table, instinct is a view.
  --         Drop the existing instinct_* alias view, rename the table,
  --         create the reverse compat view.
  -- =========================================================
  ELSIF apex_exists_as_table AND instinct_kind = 'v' THEN
    EXECUTE 'DROP VIEW instinct_ms_tokens';
    EXECUTE 'ALTER TABLE apex_ms_tokens RENAME TO instinct_ms_tokens';
    EXECUTE 'CREATE OR REPLACE VIEW apex_ms_tokens AS SELECT * FROM instinct_ms_tokens';
    RAISE NOTICE 'Renamed apex_ms_tokens → instinct_ms_tokens; compat view created.';

  -- =========================================================
  -- Case C: pre-rename but the alias view was dropped elsewhere.
  --         Just rename the table + create compat view.
  -- =========================================================
  ELSIF apex_exists_as_table AND instinct_kind IS NULL THEN
    EXECUTE 'ALTER TABLE apex_ms_tokens RENAME TO instinct_ms_tokens';
    EXECUTE 'CREATE OR REPLACE VIEW apex_ms_tokens AS SELECT * FROM instinct_ms_tokens';
    RAISE NOTICE 'Renamed apex_ms_tokens → instinct_ms_tokens (no pre-existing alias view); compat view created.';

  -- =========================================================
  -- Case D: Mystery state — instinct_ms_tokens exists as something
  --         other than a view or table (materialized view, sequence,
  --         foreign table, composite type, etc.). Abort with a clear
  --         error so a human investigates.
  -- =========================================================
  ELSIF instinct_kind IS NOT NULL AND instinct_kind NOT IN ('r', 'v') THEN
    RAISE EXCEPTION 'Refusing to proceed: instinct_ms_tokens exists as relkind=% — manual inspection required.', instinct_kind;

  -- =========================================================
  -- Case E: apex_ms_tokens gone AND instinct_ms_tokens is a view.
  --         Orphan-view cleanup: drop the view.
  -- =========================================================
  ELSIF NOT apex_exists_as_table AND instinct_kind = 'v' THEN
    EXECUTE 'DROP VIEW instinct_ms_tokens';
    RAISE NOTICE 'Dropped orphan view instinct_ms_tokens; apex_ms_tokens table is absent.';

  -- =========================================================
  -- Case F: neither exists — no-op (migrations 005/014 never ran here).
  -- =========================================================
  ELSE
    RAISE NOTICE 'Neither apex_ms_tokens nor instinct_ms_tokens exists; nothing to rename.';
  END IF;

  -- Row-count assertion: if we had a source table, the post-rename
  -- count must match exactly. ALTER TABLE RENAME is metadata-only so
  -- row count is always preserved; any mismatch means the rename did
  -- not happen as expected or the table we landed on is different from
  -- what we started with. Either way, abort.
  IF pre_rename_count IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT COUNT(*) FROM instinct_ms_tokens' INTO post_rename_count;
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
-- Migrations 005 + 006 established these names on the underlying table:
--   idx_apex_ms_tokens_email         (non-unique, column: user_email)
--   idx_apex_ms_tokens_connected_by  (UNIQUE,     column: connected_by)
ALTER INDEX IF EXISTS idx_apex_ms_tokens_email
  RENAME TO idx_instinct_ms_tokens_email;
ALTER INDEX IF EXISTS idx_apex_ms_tokens_connected_by
  RENAME TO idx_instinct_ms_tokens_connected_by;

-- =========================================================================
-- Compat-view updatability assertion.
--
-- The backward-compat view created above is supposed to be auto-updatable
-- (simple passthrough SELECT * FROM ...) so any legacy code reference
-- INSERTing / UPDATEing / DELETEing via apex_ms_tokens still propagates
-- to the renamed underlying table. microsoft-graph.ts has INSERT + ON
-- CONFLICT + DELETE paths against this table, and tasks/webhook/route.ts
-- has SELECT paths. Updatable-AND-insertable is non-negotiable.
--
-- If for any reason the view is NOT updatable (Postgres rewriter
-- disagrees about shape, the underlying table has a column we missed,
-- an RLS policy blocks the view path, etc.), this assertion RAISES
-- EXCEPTION and the whole migration is rolled back. No silent
-- write-discard for OAuth tokens.
-- =========================================================================
DO $$
DECLARE
  is_updatable TEXT;
  is_insertable TEXT;
BEGIN
  -- Only assert if the compat view was actually created (Cases B, C, A).
  -- Cases D, E, F skipped the view creation intentionally.
  IF EXISTS (
    SELECT 1 FROM information_schema.views
    WHERE table_schema = current_schema()
      AND table_name = 'apex_ms_tokens'
  ) THEN
    SELECT v.is_updatable, v.is_insertable_into
      INTO is_updatable, is_insertable
      FROM information_schema.views v
      WHERE v.table_schema = current_schema()
        AND v.table_name = 'apex_ms_tokens';

    IF is_updatable != 'YES' THEN
      RAISE EXCEPTION 'Compat view apex_ms_tokens is NOT updatable (is_updatable=%). Legacy code UPDATEs/DELETEs would silently fail. Aborting.', is_updatable;
    END IF;
    IF is_insertable != 'YES' THEN
      RAISE EXCEPTION 'Compat view apex_ms_tokens is NOT insertable (is_insertable_into=%). Legacy code INSERTs would silently fail. Aborting.', is_insertable;
    END IF;
    RAISE NOTICE 'Compat view apex_ms_tokens is fully R/W (is_updatable=%, is_insertable_into=%).', is_updatable, is_insertable;
  END IF;
END $$;

COMMIT;
