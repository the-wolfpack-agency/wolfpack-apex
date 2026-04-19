-- Tier 4 DB rename batch 5 / stream U5 (part 2/2): apex_discussion_replies → instinct_discussion_replies
--
-- Sibling migrations in this batch:
--   059 — apex_discussions         → instinct_discussions         (FK parent; runs first)
--   060 — apex_discussion_replies  → instinct_discussion_replies  (this file — FK child)
--
-- The discussions family renames together because `apex_discussion_replies.discussion_id`
-- FKs the parent. When 059 ran, it already renamed the parent table; Postgres preserves
-- the FK across ALTER TABLE RENAME on either side (FK metadata tracks OIDs, not names),
-- so this migration does NOT need to touch or rebuild the FK — it survives the rename
-- transparently.
--
-- Safety-first design — same structure as 050_rename_meeting_transcripts.sql
-- (learning-view precedent) and 059_rename_discussions.sql:
--
--   1. DEFENSIVE RENAME — handles any prior state (fresh DB, already-
--      renamed DB, partial-rollback states) so the migration never
--      aborts the deploy.
--
--   2. BACKWARD-COMPAT VIEW — after the rename, `apex_discussion_replies`
--      becomes an auto-updatable pass-through view. Any missed code
--      reference (SELECT, INSERT, UPDATE, DELETE) still works against
--      the OLD name so data flow never silently drops.
--
--   3. ROW-COUNT ASSERTION — snapshots COUNT(*) before the rename,
--      compares after, RAISES EXCEPTION if they don't match.
--
-- Starting-state specifics for THIS rename:
--   • `apex_discussion_replies` is the real table (migration 001). Columns:
--       id TEXT PK, discussion_id TEXT FK→instinct_discussions(id) ON DELETE CASCADE,
--       author_id TEXT, content TEXT, attachments JSONB, created_at TIMESTAMPTZ.
--     (The FK target was renamed from apex_discussions to instinct_discussions
--     by migration 059, but the FK itself was preserved automatically.)
--
--   • Two secondary indexes from migration 001:
--       idx_apex_replies_discussion ON (discussion_id)
--       idx_apex_replies_author     ON (author_id)
--
--   • Two views depend on the old name and must be handled here:
--       a) `instinct_discussion_replies` — migration-014 alias view
--          (SELECT * FROM apex_discussion_replies). Dropped in Case B,
--          replaced implicitly by the new real table after RENAME.
--       b) `v_discussion_velocity` — migration-002 learning view,
--          rebuilt by migration 059 to point at `instinct_discussions`
--          but still referencing `apex_discussion_replies`. That view
--          MUST be dropped here before the rename (0A000 feature_not_supported
--          otherwise) and rebuilt against BOTH renamed tables.

BEGIN;

DO $$
DECLARE
  apex_exists_as_table BOOLEAN;
  instinct_kind CHAR;
  pre_rename_count BIGINT := NULL;
  post_rename_count BIGINT;
  velocity_view_existed BOOLEAN := FALSE;
  parent_is_renamed BOOLEAN := FALSE;
BEGIN
  -- Does apex_discussion_replies still exist as a regular table?
  SELECT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'apex_discussion_replies'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
  ) INTO apex_exists_as_table;

  -- What is instinct_discussion_replies right now? (NULL = doesn't exist)
  SELECT c.relkind
    INTO instinct_kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_discussion_replies'
      AND n.nspname = current_schema()
    LIMIT 1;

  -- Does the migration-002 learning view exist? Track it so we know
  -- whether to rebuild post-rename.
  SELECT EXISTS (
    SELECT 1 FROM information_schema.views
    WHERE table_schema = current_schema()
      AND table_name = 'v_discussion_velocity'
  ) INTO velocity_view_existed;

  -- Is the parent table already renamed (i.e. did 059 run)?
  -- We use this to pick which parent-table name to target in the
  -- rebuilt view. In any real deploy after this batch, 059 ran first
  -- so parent_is_renamed = TRUE. We keep the branch for resilience.
  SELECT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_discussions'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
  ) INTO parent_is_renamed;

  -- Snapshot row count BEFORE the rename.
  IF apex_exists_as_table THEN
    EXECUTE 'SELECT COUNT(*) FROM apex_discussion_replies' INTO pre_rename_count;
  ELSIF instinct_kind = 'r' THEN
    EXECUTE 'SELECT COUNT(*) FROM instinct_discussion_replies' INTO pre_rename_count;
  END IF;

  -- =========================================================
  -- Case A: already renamed — instinct is the table.
  --         Ensure the backward-compat view exists and the learning
  --         view (if it existed) points at the fully-renamed pair.
  -- =========================================================
  IF instinct_kind = 'r' AND NOT apex_exists_as_table THEN
    EXECUTE 'CREATE OR REPLACE VIEW apex_discussion_replies AS SELECT * FROM instinct_discussion_replies';
    IF velocity_view_existed THEN
      IF parent_is_renamed THEN
        EXECUTE $v$CREATE OR REPLACE VIEW v_discussion_velocity AS
          SELECT
            d.category,
            COUNT(*) AS total_threads,
            COUNT(*) FILTER (WHERE d.status = 'resolved') AS resolved,
            AVG(
              EXTRACT(EPOCH FROM (
                (SELECT MIN(r.created_at) FROM instinct_discussion_replies r
                 WHERE r.discussion_id = d.id AND r.content ILIKE '%resolved%')
                - d.created_at
              )) / 3600
            ) AS avg_resolution_hours
          FROM instinct_discussions d
          GROUP BY d.category$v$;
      ELSE
        -- Parent somehow still apex_* (059 rolled back or never ran).
        -- Fall back to apex_discussions (compat view) on the parent side.
        EXECUTE $v$CREATE OR REPLACE VIEW v_discussion_velocity AS
          SELECT
            d.category,
            COUNT(*) AS total_threads,
            COUNT(*) FILTER (WHERE d.status = 'resolved') AS resolved,
            AVG(
              EXTRACT(EPOCH FROM (
                (SELECT MIN(r.created_at) FROM instinct_discussion_replies r
                 WHERE r.discussion_id = d.id AND r.content ILIKE '%resolved%')
                - d.created_at
              )) / 3600
            ) AS avg_resolution_hours
          FROM apex_discussions d
          GROUP BY d.category$v$;
      END IF;
    END IF;
    RAISE NOTICE 'Already renamed; ensured compat view apex_discussion_replies exists.';

  -- =========================================================
  -- Case B: clean pre-rename — apex is the table, instinct is a view
  --         (the migration-014 alias view). Drop the learning view
  --         first (it SELECTs FROM apex_discussion_replies), drop the
  --         migration-014 alias, rename the table, rebuild the
  --         learning view, create the reverse compat view.
  -- =========================================================
  ELSIF apex_exists_as_table AND instinct_kind = 'v' THEN
    IF velocity_view_existed THEN
      EXECUTE 'DROP VIEW v_discussion_velocity';
    END IF;
    EXECUTE 'DROP VIEW instinct_discussion_replies';
    EXECUTE 'ALTER TABLE apex_discussion_replies RENAME TO instinct_discussion_replies';
    IF velocity_view_existed THEN
      IF parent_is_renamed THEN
        EXECUTE $v$CREATE OR REPLACE VIEW v_discussion_velocity AS
          SELECT
            d.category,
            COUNT(*) AS total_threads,
            COUNT(*) FILTER (WHERE d.status = 'resolved') AS resolved,
            AVG(
              EXTRACT(EPOCH FROM (
                (SELECT MIN(r.created_at) FROM instinct_discussion_replies r
                 WHERE r.discussion_id = d.id AND r.content ILIKE '%resolved%')
                - d.created_at
              )) / 3600
            ) AS avg_resolution_hours
          FROM instinct_discussions d
          GROUP BY d.category$v$;
      ELSE
        EXECUTE $v$CREATE OR REPLACE VIEW v_discussion_velocity AS
          SELECT
            d.category,
            COUNT(*) AS total_threads,
            COUNT(*) FILTER (WHERE d.status = 'resolved') AS resolved,
            AVG(
              EXTRACT(EPOCH FROM (
                (SELECT MIN(r.created_at) FROM instinct_discussion_replies r
                 WHERE r.discussion_id = d.id AND r.content ILIKE '%resolved%')
                - d.created_at
              )) / 3600
            ) AS avg_resolution_hours
          FROM apex_discussions d
          GROUP BY d.category$v$;
      END IF;
    END IF;
    EXECUTE 'CREATE OR REPLACE VIEW apex_discussion_replies AS SELECT * FROM instinct_discussion_replies';
    RAISE NOTICE 'Renamed apex_discussion_replies → instinct_discussion_replies; dependent view rebuilt; compat view created.';

  -- =========================================================
  -- Case C: pre-rename but the alias view was dropped elsewhere.
  -- =========================================================
  ELSIF apex_exists_as_table AND instinct_kind IS NULL THEN
    IF velocity_view_existed THEN
      EXECUTE 'DROP VIEW v_discussion_velocity';
    END IF;
    EXECUTE 'ALTER TABLE apex_discussion_replies RENAME TO instinct_discussion_replies';
    IF velocity_view_existed THEN
      IF parent_is_renamed THEN
        EXECUTE $v$CREATE OR REPLACE VIEW v_discussion_velocity AS
          SELECT
            d.category,
            COUNT(*) AS total_threads,
            COUNT(*) FILTER (WHERE d.status = 'resolved') AS resolved,
            AVG(
              EXTRACT(EPOCH FROM (
                (SELECT MIN(r.created_at) FROM instinct_discussion_replies r
                 WHERE r.discussion_id = d.id AND r.content ILIKE '%resolved%')
                - d.created_at
              )) / 3600
            ) AS avg_resolution_hours
          FROM instinct_discussions d
          GROUP BY d.category$v$;
      ELSE
        EXECUTE $v$CREATE OR REPLACE VIEW v_discussion_velocity AS
          SELECT
            d.category,
            COUNT(*) AS total_threads,
            COUNT(*) FILTER (WHERE d.status = 'resolved') AS resolved,
            AVG(
              EXTRACT(EPOCH FROM (
                (SELECT MIN(r.created_at) FROM instinct_discussion_replies r
                 WHERE r.discussion_id = d.id AND r.content ILIKE '%resolved%')
                - d.created_at
              )) / 3600
            ) AS avg_resolution_hours
          FROM apex_discussions d
          GROUP BY d.category$v$;
      END IF;
    END IF;
    EXECUTE 'CREATE OR REPLACE VIEW apex_discussion_replies AS SELECT * FROM instinct_discussion_replies';
    RAISE NOTICE 'Renamed apex_discussion_replies → instinct_discussion_replies (no pre-existing alias view); dependent view rebuilt; compat view created.';

  -- =========================================================
  -- Case D: Mystery state — abort for investigation.
  -- =========================================================
  ELSIF instinct_kind IS NOT NULL AND instinct_kind NOT IN ('r', 'v') THEN
    RAISE EXCEPTION 'Refusing to proceed: instinct_discussion_replies exists as relkind=% — manual inspection required.', instinct_kind;

  -- =========================================================
  -- Case E: apex gone AND instinct is a view. Orphan-view cleanup.
  -- =========================================================
  ELSIF NOT apex_exists_as_table AND instinct_kind = 'v' THEN
    EXECUTE 'DROP VIEW instinct_discussion_replies';
    RAISE NOTICE 'Dropped orphan view instinct_discussion_replies; apex_discussion_replies table is absent.';

  -- =========================================================
  -- Case F: neither exists — no-op.
  -- =========================================================
  ELSE
    RAISE NOTICE 'Neither apex_discussion_replies nor instinct_discussion_replies exists; nothing to rename.';
  END IF;

  -- Row-count assertion.
  IF pre_rename_count IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT COUNT(*) FROM instinct_discussion_replies' INTO post_rename_count;
    EXCEPTION WHEN undefined_table THEN
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
--   idx_apex_replies_discussion ON apex_discussion_replies (discussion_id)
--   idx_apex_replies_author     ON apex_discussion_replies (author_id)
-- We standardize on the `idx_instinct_discussion_replies_*` naming so
-- `\d instinct_discussion_replies` shows consistent, descriptive names.
ALTER INDEX IF EXISTS idx_apex_replies_discussion
  RENAME TO idx_instinct_discussion_replies_discussion;
ALTER INDEX IF EXISTS idx_apex_replies_author
  RENAME TO idx_instinct_discussion_replies_author;

-- =========================================================================
-- Compat-view updatability assertion.
--
-- The backward-compat view created above is supposed to be auto-updatable
-- (simple passthrough SELECT * FROM ...) so any legacy code reference
-- INSERTing / UPDATEing / DELETEing via apex_discussion_replies still
-- propagates to the renamed underlying table. discussions.ts has INSERT
-- paths hitting this table (createThread's initial reply, replyToThread),
-- so updatable-AND-insertable is non-negotiable.
-- =========================================================================
DO $$
DECLARE
  is_updatable TEXT;
  is_insertable TEXT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.views
    WHERE table_schema = current_schema()
      AND table_name = 'apex_discussion_replies'
  ) THEN
    SELECT v.is_updatable, v.is_insertable_into
      INTO is_updatable, is_insertable
      FROM information_schema.views v
      WHERE v.table_schema = current_schema()
        AND v.table_name = 'apex_discussion_replies';

    IF is_updatable != 'YES' THEN
      RAISE EXCEPTION 'Compat view apex_discussion_replies is NOT updatable (is_updatable=%). Legacy code UPDATEs/DELETEs would silently fail. Aborting.', is_updatable;
    END IF;
    IF is_insertable != 'YES' THEN
      RAISE EXCEPTION 'Compat view apex_discussion_replies is NOT insertable (is_insertable_into=%). Legacy code INSERTs would silently fail. Aborting.', is_insertable;
    END IF;
    RAISE NOTICE 'Compat view apex_discussion_replies is fully R/W (is_updatable=%, is_insertable_into=%).', is_updatable, is_insertable;
  END IF;
END $$;

COMMIT;
