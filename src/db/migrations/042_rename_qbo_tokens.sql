-- Tier 4 DB rename (batch 2, stream S2): apex_qbo_tokens → instinct_qbo_tokens
--
-- QuickBooks OAuth2 token storage. Security-sensitive: contains refresh
-- tokens for a third-party financial integration. The defensive pattern
-- from migration 036 is mandatory here — we cannot lose these tokens
-- (re-auth flow would interrupt every connected customer).
--
-- Safety-first design (same as 036 pilot):
--
--   1. DEFENSIVE RENAME — handles any prior state (fresh DB, already-
--      renamed DB, partial-rollback states) so the migration never
--      aborts the deploy.
--
--   2. BACKWARD-COMPAT VIEW — after the rename, `apex_qbo_tokens`
--      becomes an auto-updatable pass-through view to the renamed
--      table. Any missed code reference (SELECT, INSERT, UPDATE, DELETE)
--      still works against the OLD name so data flow never silently
--      drops. The compat view is removed in a follow-up migration once
--      we've verified every reference is updated.
--
--   3. ROW-COUNT ASSERTION — snapshots COUNT(*) before the rename,
--      compares after, RAISES EXCEPTION if they don't match.
--
--   4. DEPENDENT VIEW HANDLING — migration 014 creates the alias view
--      `instinct_qbo_tokens` as SELECT * FROM apex_qbo_tokens. That
--      view must be dropped before ALTER TABLE (Case B).
--
-- Column-type safety: apex_qbo_tokens uses `connected_by TEXT`. There
-- are NO UUID user-id columns on this table, so the schema invariant
-- test (src/db/__tests__/user-id-columns-schema.test.ts) cannot trip.

BEGIN;

DO $$
DECLARE
  apex_exists_as_table BOOLEAN;
  instinct_kind CHAR;
  pre_rename_count BIGINT := NULL;
  post_rename_count BIGINT;
BEGIN
  -- Does apex_qbo_tokens still exist as a regular table?
  SELECT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'apex_qbo_tokens'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
  ) INTO apex_exists_as_table;

  -- What is instinct_qbo_tokens right now? (NULL = doesn't exist)
  SELECT c.relkind
    INTO instinct_kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_qbo_tokens'
      AND n.nspname = current_schema()
    LIMIT 1;

  -- Snapshot row count BEFORE the rename.
  IF apex_exists_as_table THEN
    EXECUTE 'SELECT COUNT(*) FROM apex_qbo_tokens' INTO pre_rename_count;
  ELSIF instinct_kind = 'r' THEN
    EXECUTE 'SELECT COUNT(*) FROM instinct_qbo_tokens' INTO pre_rename_count;
  END IF;

  -- =========================================================
  -- Case A: already renamed — instinct is the table.
  --         Ensure the backward-compat view exists.
  -- =========================================================
  IF instinct_kind = 'r' AND NOT apex_exists_as_table THEN
    EXECUTE 'CREATE OR REPLACE VIEW apex_qbo_tokens AS SELECT * FROM instinct_qbo_tokens';
    RAISE NOTICE 'Already renamed; ensured compat view apex_qbo_tokens exists.';

  -- =========================================================
  -- Case B: clean pre-rename — apex is the table, instinct is a view.
  --         Drop the existing instinct_* alias view, rename the table,
  --         create the reverse compat view.
  -- =========================================================
  ELSIF apex_exists_as_table AND instinct_kind = 'v' THEN
    EXECUTE 'DROP VIEW instinct_qbo_tokens';
    EXECUTE 'ALTER TABLE apex_qbo_tokens RENAME TO instinct_qbo_tokens';
    EXECUTE 'CREATE OR REPLACE VIEW apex_qbo_tokens AS SELECT * FROM instinct_qbo_tokens';
    RAISE NOTICE 'Renamed apex_qbo_tokens → instinct_qbo_tokens; compat view created.';

  -- =========================================================
  -- Case C: pre-rename but the alias view was dropped elsewhere.
  -- =========================================================
  ELSIF apex_exists_as_table AND instinct_kind IS NULL THEN
    EXECUTE 'ALTER TABLE apex_qbo_tokens RENAME TO instinct_qbo_tokens';
    EXECUTE 'CREATE OR REPLACE VIEW apex_qbo_tokens AS SELECT * FROM instinct_qbo_tokens';
    RAISE NOTICE 'Renamed apex_qbo_tokens → instinct_qbo_tokens (no pre-existing alias view); compat view created.';

  -- =========================================================
  -- Case D: Mystery state — abort.
  -- =========================================================
  ELSIF instinct_kind IS NOT NULL AND instinct_kind NOT IN ('r', 'v') THEN
    RAISE EXCEPTION 'Refusing to proceed: instinct_qbo_tokens exists as relkind=% — manual inspection required.', instinct_kind;

  -- =========================================================
  -- Case E: orphan view cleanup.
  -- =========================================================
  ELSIF NOT apex_exists_as_table AND instinct_kind = 'v' THEN
    EXECUTE 'DROP VIEW instinct_qbo_tokens';
    RAISE NOTICE 'Dropped orphan view instinct_qbo_tokens; apex_qbo_tokens table is absent.';

  -- =========================================================
  -- Case F: neither exists — no-op.
  -- =========================================================
  ELSE
    RAISE NOTICE 'Neither apex_qbo_tokens nor instinct_qbo_tokens exists; nothing to rename.';
  END IF;

  -- Row-count assertion.
  IF pre_rename_count IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT COUNT(*) FROM instinct_qbo_tokens' INTO post_rename_count;
    EXCEPTION WHEN undefined_table THEN
      post_rename_count := NULL;
    END;
    IF post_rename_count IS NOT NULL AND post_rename_count != pre_rename_count THEN
      RAISE EXCEPTION 'Row-count mismatch after rename: pre=% post=% — aborting.', pre_rename_count, post_rename_count;
    END IF;
    RAISE NOTICE 'Row-count assertion passed: % rows preserved.', COALESCE(pre_rename_count, 0);
  END IF;
END $$;

-- Index rename (idempotent). The original migration 004 created the
-- index as `idx_qbo_tokens_realm` (no apex_ prefix), so we align it
-- with the instinct_* naming convention used by later migrations.
ALTER INDEX IF EXISTS idx_qbo_tokens_realm RENAME TO idx_instinct_qbo_tokens_realm;

-- =========================================================================
-- Compat-view updatability assertion.
--
-- Verifies the passthrough view is fully R/W so missed legacy code
-- references (INSERT/UPDATE/DELETE via apex_qbo_tokens) propagate to
-- the renamed table. Without this assertion, a missed write path could
-- silently succeed at the wire level while discarding data — a
-- catastrophic failure mode for OAuth token storage.
-- =========================================================================
DO $$
DECLARE
  is_updatable TEXT;
  is_insertable TEXT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.views
    WHERE table_schema = current_schema()
      AND table_name = 'apex_qbo_tokens'
  ) THEN
    SELECT v.is_updatable, v.is_insertable_into
      INTO is_updatable, is_insertable
      FROM information_schema.views v
      WHERE v.table_schema = current_schema()
        AND v.table_name = 'apex_qbo_tokens';

    IF is_updatable != 'YES' THEN
      RAISE EXCEPTION 'Compat view apex_qbo_tokens is NOT updatable (is_updatable=%). Legacy code UPDATEs/DELETEs would silently fail. Aborting.', is_updatable;
    END IF;
    IF is_insertable != 'YES' THEN
      RAISE EXCEPTION 'Compat view apex_qbo_tokens is NOT insertable (is_insertable_into=%). Legacy code INSERTs would silently fail. Aborting.', is_insertable;
    END IF;
    RAISE NOTICE 'Compat view apex_qbo_tokens is fully R/W (is_updatable=%, is_insertable_into=%).', is_updatable, is_insertable;
  END IF;
END $$;

COMMIT;
