-- Tier 4 DB rename batch 5 / stream U5 (part 1/2): apex_discussions → instinct_discussions
--
-- Sibling migrations in this batch:
--   059 — apex_discussions          → instinct_discussions          (this file)
--   060 — apex_discussion_replies   → instinct_discussion_replies   (paired with 059 — FK parent)
--
-- The discussions family renames together because `apex_discussion_replies.discussion_id`
-- FKs `apex_discussions(id)`. Postgres preserves FKs across ALTER TABLE RENAME (the FK
-- metadata tracks table OIDs, not names), so the rename is safe — but we MUST rename both
-- siblings together so the underlying data layer stays consistent for the lib/route sweep.
--
-- Safety-first design — same structure as 036_rename_feature_requests.sql,
-- 050_rename_meeting_transcripts.sql (learning-view precedent), and 051_rename_user_memory.sql:
--
--   1. DEFENSIVE RENAME — handles any prior state (fresh DB, already-
--      renamed DB, partial-rollback states) so the migration never
--      aborts the deploy.
--
--   2. BACKWARD-COMPAT VIEW — after the rename, `apex_discussions`
--      becomes an auto-updatable pass-through view to the renamed
--      table. Any missed code reference (SELECT, INSERT, UPDATE,
--      DELETE) still works against the OLD name so data flow never
--      silently drops.
--
--   3. ROW-COUNT ASSERTION — snapshots COUNT(*) before the rename,
--      compares after, RAISES EXCEPTION if they don't match.
--
-- Starting-state specifics for THIS rename:
--   • `apex_discussions` is the real table (migration 001). Columns:
--       id TEXT PK, title TEXT, category TEXT (CHECK),
--       created_by TEXT, status TEXT (CHECK), pinned BOOLEAN,
--       tags TEXT[], created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ.
--
--   • Three secondary indexes from migration 001:
--       idx_apex_discussions_category, idx_apex_discussions_status,
--       idx_apex_discussions_created_by.
--
--   • Two views depend on the old name and must be handled here:
--       a) `instinct_discussions` — migration-014 alias view
--          (SELECT * FROM apex_discussions). Target of the flip:
--          dropped in Case B, replaced implicitly by the new real
--          table after RENAME.
--       b) `v_discussion_velocity` — migration-002 learning view
--          (non-trivial SELECT with GROUP BY, references BOTH
--          apex_discussions AND apex_discussion_replies). Postgres
--          forbids ALTER TABLE RENAME on a table a view selects
--          from (0A000 feature_not_supported), so we DROP the view
--          before the rename and REBUILD it after. Because
--          apex_discussion_replies is still present at the end of
--          THIS migration (it gets renamed in 060 next), we rebuild
--          the view pointed at `instinct_discussions` +
--          `apex_discussion_replies`. Migration 060 will repeat the
--          same drop+rebuild dance, and its final rebuild will hit
--          both `instinct_discussions` AND `instinct_discussion_replies`.
--          Precedent: 040_user_id_columns_to_text and
--          050_rename_meeting_transcripts use the same pattern.
--
--   • Incoming FK: `apex_discussion_replies.discussion_id`
--     REFERENCES `apex_discussions(id)` ON DELETE CASCADE.
--     Postgres's FK bookkeeping tracks table OIDs, so the FK
--     survives ALTER TABLE RENAME automatically — no action needed.
--     The same applies to the outgoing FK side in migration 060.

BEGIN;

DO $$
DECLARE
  apex_exists_as_table BOOLEAN;
  instinct_kind CHAR;
  pre_rename_count BIGINT := NULL;
  post_rename_count BIGINT;
  velocity_view_existed BOOLEAN := FALSE;
BEGIN
  -- Does apex_discussions still exist as a regular table?
  SELECT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'apex_discussions'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
  ) INTO apex_exists_as_table;

  -- What is instinct_discussions right now? (NULL = doesn't exist)
  SELECT c.relkind
    INTO instinct_kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_discussions'
      AND n.nspname = current_schema()
    LIMIT 1;

  -- Does the migration-002 learning view exist? Track it so we know
  -- whether to rebuild post-rename (skip on fresh DBs that never ran 002).
  SELECT EXISTS (
    SELECT 1 FROM information_schema.views
    WHERE table_schema = current_schema()
      AND table_name = 'v_discussion_velocity'
  ) INTO velocity_view_existed;

  -- Snapshot row count BEFORE the rename so we can assert no rows
  -- disappeared after. Use EXECUTE+INTO for dynamic table name.
  IF apex_exists_as_table THEN
    EXECUTE 'SELECT COUNT(*) FROM apex_discussions' INTO pre_rename_count;
  ELSIF instinct_kind = 'r' THEN
    EXECUTE 'SELECT COUNT(*) FROM instinct_discussions' INTO pre_rename_count;
  END IF;

  -- =========================================================
  -- Case A: already renamed — instinct is the table.
  --         Ensure the backward-compat view exists so any legacy
  --         apex_discussions reference still works. Also make sure
  --         the learning view (if it existed) now points at the
  --         renamed table — on re-runs it may already be correct,
  --         on partial-rollback states it may not be.
  -- =========================================================
  IF instinct_kind = 'r' AND NOT apex_exists_as_table THEN
    EXECUTE 'CREATE OR REPLACE VIEW apex_discussions AS SELECT * FROM instinct_discussions';
    IF velocity_view_existed THEN
      -- Rebuild the velocity view against the renamed discussions table.
      -- Note: apex_discussion_replies may or may not already be renamed
      -- to instinct_discussion_replies at this point (migration 060 is
      -- the one that renames it). Use whichever name resolves: the
      -- apex_discussion_replies compat view keeps working either way,
      -- so pointing at apex_discussion_replies here is always safe.
      EXECUTE $v$CREATE OR REPLACE VIEW v_discussion_velocity AS
        SELECT
          d.category,
          COUNT(*) AS total_threads,
          COUNT(*) FILTER (WHERE d.status = 'resolved') AS resolved,
          AVG(
            EXTRACT(EPOCH FROM (
              (SELECT MIN(r.created_at) FROM apex_discussion_replies r
               WHERE r.discussion_id = d.id AND r.content ILIKE '%resolved%')
              - d.created_at
            )) / 3600
          ) AS avg_resolution_hours
        FROM instinct_discussions d
        GROUP BY d.category$v$;
    END IF;
    RAISE NOTICE 'Already renamed; ensured compat view apex_discussions exists.';

  -- =========================================================
  -- Case B: clean pre-rename — apex is the table, instinct is a view
  --         (the migration-014 alias view). Drop the learning view
  --         first (it SELECTs FROM apex_discussions so Postgres
  --         dependency tracker blocks the RENAME otherwise), drop
  --         the migration-014 alias, rename the table, rebuild the
  --         learning view, create the reverse compat view.
  -- =========================================================
  ELSIF apex_exists_as_table AND instinct_kind = 'v' THEN
    IF velocity_view_existed THEN
      EXECUTE 'DROP VIEW v_discussion_velocity';
    END IF;
    EXECUTE 'DROP VIEW instinct_discussions';
    EXECUTE 'ALTER TABLE apex_discussions RENAME TO instinct_discussions';
    IF velocity_view_existed THEN
      EXECUTE $v$CREATE OR REPLACE VIEW v_discussion_velocity AS
        SELECT
          d.category,
          COUNT(*) AS total_threads,
          COUNT(*) FILTER (WHERE d.status = 'resolved') AS resolved,
          AVG(
            EXTRACT(EPOCH FROM (
              (SELECT MIN(r.created_at) FROM apex_discussion_replies r
               WHERE r.discussion_id = d.id AND r.content ILIKE '%resolved%')
              - d.created_at
            )) / 3600
          ) AS avg_resolution_hours
        FROM instinct_discussions d
        GROUP BY d.category$v$;
    END IF;
    EXECUTE 'CREATE OR REPLACE VIEW apex_discussions AS SELECT * FROM instinct_discussions';
    RAISE NOTICE 'Renamed apex_discussions → instinct_discussions; dependent view rebuilt; compat view created.';

  -- =========================================================
  -- Case C: pre-rename but the alias view was dropped elsewhere.
  --         Still must handle the learning view (same dep issue).
  -- =========================================================
  ELSIF apex_exists_as_table AND instinct_kind IS NULL THEN
    IF velocity_view_existed THEN
      EXECUTE 'DROP VIEW v_discussion_velocity';
    END IF;
    EXECUTE 'ALTER TABLE apex_discussions RENAME TO instinct_discussions';
    IF velocity_view_existed THEN
      EXECUTE $v$CREATE OR REPLACE VIEW v_discussion_velocity AS
        SELECT
          d.category,
          COUNT(*) AS total_threads,
          COUNT(*) FILTER (WHERE d.status = 'resolved') AS resolved,
          AVG(
            EXTRACT(EPOCH FROM (
              (SELECT MIN(r.created_at) FROM apex_discussion_replies r
               WHERE r.discussion_id = d.id AND r.content ILIKE '%resolved%')
              - d.created_at
            )) / 3600
          ) AS avg_resolution_hours
        FROM instinct_discussions d
        GROUP BY d.category$v$;
    END IF;
    EXECUTE 'CREATE OR REPLACE VIEW apex_discussions AS SELECT * FROM instinct_discussions';
    RAISE NOTICE 'Renamed apex_discussions → instinct_discussions (no pre-existing alias view); dependent view rebuilt; compat view created.';

  -- =========================================================
  -- Case D: Mystery state — instinct_discussions exists as something
  --         other than a view or table (materialized view, sequence,
  --         foreign table, composite type, etc.). Abort with a clear
  --         error so a human investigates.
  -- =========================================================
  ELSIF instinct_kind IS NOT NULL AND instinct_kind NOT IN ('r', 'v') THEN
    RAISE EXCEPTION 'Refusing to proceed: instinct_discussions exists as relkind=% — manual inspection required.', instinct_kind;

  -- =========================================================
  -- Case E: apex_discussions gone AND instinct_discussions is a view.
  --         Orphan-view cleanup: drop the view.
  -- =========================================================
  ELSIF NOT apex_exists_as_table AND instinct_kind = 'v' THEN
    EXECUTE 'DROP VIEW instinct_discussions';
    RAISE NOTICE 'Dropped orphan view instinct_discussions; apex_discussions table is absent.';

  -- =========================================================
  -- Case F: neither exists — no-op (migrations 001/014 never ran here).
  -- =========================================================
  ELSE
    RAISE NOTICE 'Neither apex_discussions nor instinct_discussions exists; nothing to rename.';
  END IF;

  -- Row-count assertion: if we had a source table, the post-rename
  -- count must match exactly. ALTER TABLE RENAME is metadata-only so
  -- row count is always preserved; any mismatch means the rename did
  -- not happen as expected or the table we landed on is different from
  -- what we started with. Either way, abort.
  IF pre_rename_count IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT COUNT(*) FROM instinct_discussions' INTO post_rename_count;
    EXCEPTION WHEN undefined_table THEN
      post_rename_count := NULL;
    END;
    IF post_rename_count IS NOT NULL AND post_rename_count != pre_rename_count THEN
      RAISE EXCEPTION 'Row-count mismatch after rename: pre=% post=% — aborting.', pre_rename_count, post_rename_count;
    END IF;
    RAISE NOTICE 'Row-count assertion passed: % rows preserved.', COALESCE(pre_rename_count, 0);
  END IF;
END $$;

-- Rename the three secondary indexes (idempotent, independent of the
-- block above). Each guarded with IF EXISTS so any partial prior state
-- is tolerated. Migration 001 created:
--   idx_apex_discussions_category    ON apex_discussions (category)
--   idx_apex_discussions_status      ON apex_discussions (status)
--   idx_apex_discussions_created_by  ON apex_discussions (created_by)
ALTER INDEX IF EXISTS idx_apex_discussions_category
  RENAME TO idx_instinct_discussions_category;
ALTER INDEX IF EXISTS idx_apex_discussions_status
  RENAME TO idx_instinct_discussions_status;
ALTER INDEX IF EXISTS idx_apex_discussions_created_by
  RENAME TO idx_instinct_discussions_created_by;

-- =========================================================================
-- Compat-view updatability assertion.
--
-- The backward-compat view created above is supposed to be auto-updatable
-- (simple passthrough SELECT * FROM ...) so any legacy code reference
-- INSERTing / UPDATEing / DELETEing via apex_discussions still propagates
-- to the renamed underlying table. discussions.ts has INSERT, UPDATE paths
-- hitting this table (createThread, resolveThread, pinThread), so
-- updatable-AND-insertable is non-negotiable.
--
-- If for any reason the view is NOT updatable, this assertion RAISES
-- EXCEPTION and the whole migration is rolled back. No silent write-discard.
-- =========================================================================
DO $$
DECLARE
  is_updatable TEXT;
  is_insertable TEXT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.views
    WHERE table_schema = current_schema()
      AND table_name = 'apex_discussions'
  ) THEN
    SELECT v.is_updatable, v.is_insertable_into
      INTO is_updatable, is_insertable
      FROM information_schema.views v
      WHERE v.table_schema = current_schema()
        AND v.table_name = 'apex_discussions';

    IF is_updatable != 'YES' THEN
      RAISE EXCEPTION 'Compat view apex_discussions is NOT updatable (is_updatable=%). Legacy code UPDATEs/DELETEs would silently fail. Aborting.', is_updatable;
    END IF;
    IF is_insertable != 'YES' THEN
      RAISE EXCEPTION 'Compat view apex_discussions is NOT insertable (is_insertable_into=%). Legacy code INSERTs would silently fail. Aborting.', is_insertable;
    END IF;
    RAISE NOTICE 'Compat view apex_discussions is fully R/W (is_updatable=%, is_insertable_into=%).', is_updatable, is_insertable;
  END IF;
END $$;

COMMIT;
