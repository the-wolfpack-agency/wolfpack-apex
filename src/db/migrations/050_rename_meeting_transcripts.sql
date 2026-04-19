-- Tier 4 DB rename batch 4 / stream U3: apex_meeting_transcripts → instinct_meeting_transcripts
--
-- Sibling migrations in this batch (parallel streams, disjoint tables):
--   048 — apex_onboarding_instances → instinct_onboarding_instances (U1)
--   049 — apex_prototypes           → instinct_prototypes           (U2)
--   050 — apex_meeting_transcripts  → instinct_meeting_transcripts  (this file, U3)
--   051 — apex_user_memory          → instinct_user_memory          (U4)
--
-- Safety-first design — same structure as 036_rename_feature_requests.sql:
--
--   1. DEFENSIVE RENAME — handles any prior state (fresh DB, already-
--      renamed DB, partial-rollback states) so the migration never
--      aborts the deploy.
--
--   2. BACKWARD-COMPAT VIEW — after the rename, `apex_meeting_transcripts`
--      becomes an auto-updatable pass-through view to the renamed
--      table. Any missed code reference (SELECT, INSERT, UPDATE, DELETE)
--      still works against the OLD name so data flow never silently
--      drops. The compat view is removed in a follow-up migration once
--      we've verified every reference is updated.
--
--   3. ROW-COUNT ASSERTION — snapshots COUNT(*) before the rename,
--      compares after, RAISES EXCEPTION if they don't match. ALTER
--      TABLE RENAME is metadata-only so counts MUST match; any
--      mismatch aborts the entire transaction.
--
--   4. VIEW DEPENDENCIES — two views depend on the old name:
--        a) `instinct_meeting_transcripts` — migration-014 alias view
--           (SELECT * FROM apex_meeting_transcripts). Target of the
--           flip: dropped in Case B, recreated implicitly as the new
--           real table after RENAME.
--        b) `apex_v_meeting_ingestion_quality` — migration-007 learning
--           view (non-trivial SELECT with GROUP BY). Postgres forbids
--           ALTER TABLE RENAME on a table a view selects from, so we
--           must DROP the view before the rename and REBUILD it against
--           the new table name after. Precedent: 040_user_id_columns_to_text
--           does the same drop+rebuild pattern for `instinct_share_tokens`.
--           This view is out-of-scope for the apex→instinct rename
--           project (view names are not being renamed this pass), so
--           we rebuild it with its original name pointing at the new
--           underlying table.

BEGIN;

DO $$
DECLARE
  apex_exists_as_table BOOLEAN;
  instinct_kind CHAR;
  pre_rename_count BIGINT := NULL;
  post_rename_count BIGINT;
  quality_view_existed BOOLEAN := FALSE;
BEGIN
  -- Does apex_meeting_transcripts still exist as a regular table?
  SELECT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'apex_meeting_transcripts'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
  ) INTO apex_exists_as_table;

  -- What is instinct_meeting_transcripts right now? (NULL = doesn't exist)
  SELECT c.relkind
    INTO instinct_kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_meeting_transcripts'
      AND n.nspname = current_schema()
    LIMIT 1;

  -- Does the learning view from migration 007 exist? We track this so
  -- we know whether to rebuild it post-rename (only if it was there to
  -- start with — on fresh DBs that somehow skipped 007 we don't want
  -- to invent it).
  SELECT EXISTS (
    SELECT 1 FROM information_schema.views
    WHERE table_schema = current_schema()
      AND table_name = 'apex_v_meeting_ingestion_quality'
  ) INTO quality_view_existed;

  -- Snapshot row count BEFORE the rename so we can assert no rows
  -- disappeared after. Use EXECUTE+INTO for dynamic table name.
  IF apex_exists_as_table THEN
    EXECUTE 'SELECT COUNT(*) FROM apex_meeting_transcripts' INTO pre_rename_count;
  ELSIF instinct_kind = 'r' THEN
    EXECUTE 'SELECT COUNT(*) FROM instinct_meeting_transcripts' INTO pre_rename_count;
  END IF;

  -- =========================================================
  -- Case A: already renamed — instinct is the table.
  --         Ensure the backward-compat view exists so any legacy
  --         apex_meeting_transcripts reference still works. Also
  --         make sure the learning view (if it existed) now points
  --         at the renamed table — on re-runs it may already be
  --         correct, on partial-rollback states it may not be.
  -- =========================================================
  IF instinct_kind = 'r' AND NOT apex_exists_as_table THEN
    EXECUTE 'CREATE OR REPLACE VIEW apex_meeting_transcripts AS SELECT * FROM instinct_meeting_transcripts';
    IF quality_view_existed THEN
      -- CREATE OR REPLACE preserves existing privileges; no data impact.
      EXECUTE $v$CREATE OR REPLACE VIEW apex_v_meeting_ingestion_quality AS
        SELECT
          owner_user_id,
          COUNT(*)                                                    AS total_transcripts,
          SUM(CASE WHEN quality_status = 'pass'   THEN 1 ELSE 0 END)  AS passed,
          SUM(CASE WHEN quality_status = 'warn'   THEN 1 ELSE 0 END)  AS warned,
          SUM(CASE WHEN quality_status = 'reject' THEN 1 ELSE 0 END)  AS rejected,
          MAX(ingested_at)                                            AS last_ingest_at,
          AVG(duration_seconds)::INTEGER                              AS avg_duration_seconds
        FROM instinct_meeting_transcripts
        GROUP BY owner_user_id$v$;
    END IF;
    RAISE NOTICE 'Already renamed; ensured compat view apex_meeting_transcripts exists.';

  -- =========================================================
  -- Case B: clean pre-rename — apex is the table, instinct is a view
  --         (the migration-014 alias view). Drop BOTH dependent views
  --         (alias + learning view), rename the table, rebuild the
  --         learning view against the new name, create the reverse
  --         compat view.
  -- =========================================================
  ELSIF apex_exists_as_table AND instinct_kind = 'v' THEN
    -- Drop the learning view first — it selects FROM apex_meeting_transcripts
    -- so Postgres's dependency tracker would block the RENAME otherwise.
    IF quality_view_existed THEN
      EXECUTE 'DROP VIEW apex_v_meeting_ingestion_quality';
    END IF;
    -- Drop the migration-014 alias view so the target name is free.
    EXECUTE 'DROP VIEW instinct_meeting_transcripts';
    -- Rename the underlying table (metadata-only, no row movement).
    EXECUTE 'ALTER TABLE apex_meeting_transcripts RENAME TO instinct_meeting_transcripts';
    -- Rebuild the learning view pointed at the new table name.
    IF quality_view_existed THEN
      EXECUTE $v$CREATE OR REPLACE VIEW apex_v_meeting_ingestion_quality AS
        SELECT
          owner_user_id,
          COUNT(*)                                                    AS total_transcripts,
          SUM(CASE WHEN quality_status = 'pass'   THEN 1 ELSE 0 END)  AS passed,
          SUM(CASE WHEN quality_status = 'warn'   THEN 1 ELSE 0 END)  AS warned,
          SUM(CASE WHEN quality_status = 'reject' THEN 1 ELSE 0 END)  AS rejected,
          MAX(ingested_at)                                            AS last_ingest_at,
          AVG(duration_seconds)::INTEGER                              AS avg_duration_seconds
        FROM instinct_meeting_transcripts
        GROUP BY owner_user_id$v$;
    END IF;
    -- Reverse compat view so the OLD name still works for any missed reference.
    EXECUTE 'CREATE OR REPLACE VIEW apex_meeting_transcripts AS SELECT * FROM instinct_meeting_transcripts';
    RAISE NOTICE 'Renamed apex_meeting_transcripts → instinct_meeting_transcripts; dependent view rebuilt; compat view created.';

  -- =========================================================
  -- Case C: pre-rename but the alias view was dropped elsewhere.
  --         Still must handle the learning view (same dep issue).
  -- =========================================================
  ELSIF apex_exists_as_table AND instinct_kind IS NULL THEN
    IF quality_view_existed THEN
      EXECUTE 'DROP VIEW apex_v_meeting_ingestion_quality';
    END IF;
    EXECUTE 'ALTER TABLE apex_meeting_transcripts RENAME TO instinct_meeting_transcripts';
    IF quality_view_existed THEN
      EXECUTE $v$CREATE OR REPLACE VIEW apex_v_meeting_ingestion_quality AS
        SELECT
          owner_user_id,
          COUNT(*)                                                    AS total_transcripts,
          SUM(CASE WHEN quality_status = 'pass'   THEN 1 ELSE 0 END)  AS passed,
          SUM(CASE WHEN quality_status = 'warn'   THEN 1 ELSE 0 END)  AS warned,
          SUM(CASE WHEN quality_status = 'reject' THEN 1 ELSE 0 END)  AS rejected,
          MAX(ingested_at)                                            AS last_ingest_at,
          AVG(duration_seconds)::INTEGER                              AS avg_duration_seconds
        FROM instinct_meeting_transcripts
        GROUP BY owner_user_id$v$;
    END IF;
    EXECUTE 'CREATE OR REPLACE VIEW apex_meeting_transcripts AS SELECT * FROM instinct_meeting_transcripts';
    RAISE NOTICE 'Renamed apex_meeting_transcripts → instinct_meeting_transcripts (no pre-existing alias view); dependent view rebuilt; compat view created.';

  -- =========================================================
  -- Case D: Mystery state — instinct_meeting_transcripts exists as
  --         something other than a view or table (materialized view,
  --         sequence, foreign table, composite type, etc.). Abort with
  --         a clear error so a human investigates.
  -- =========================================================
  ELSIF instinct_kind IS NOT NULL AND instinct_kind NOT IN ('r', 'v') THEN
    RAISE EXCEPTION 'Refusing to proceed: instinct_meeting_transcripts exists as relkind=% — manual inspection required.', instinct_kind;

  -- =========================================================
  -- Case E: apex_meeting_transcripts gone AND instinct_meeting_transcripts
  --         is a view. Orphan-view cleanup: drop the view.
  -- =========================================================
  ELSIF NOT apex_exists_as_table AND instinct_kind = 'v' THEN
    EXECUTE 'DROP VIEW instinct_meeting_transcripts';
    RAISE NOTICE 'Dropped orphan view instinct_meeting_transcripts; apex_meeting_transcripts table is absent.';

  -- =========================================================
  -- Case F: neither exists — no-op (migrations 007/014 never ran here).
  -- =========================================================
  ELSE
    RAISE NOTICE 'Neither apex_meeting_transcripts nor instinct_meeting_transcripts exists; nothing to rename.';
  END IF;

  -- Row-count assertion: if we had a source table, the post-rename
  -- count must match exactly. ALTER TABLE RENAME is metadata-only so
  -- row count is always preserved; any mismatch means the rename did
  -- not happen as expected or the table we landed on is different from
  -- what we started with. Either way, abort.
  IF pre_rename_count IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT COUNT(*) FROM instinct_meeting_transcripts' INTO post_rename_count;
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

-- Rename the three indexes (idempotent, independent of the block above).
-- Each guarded with IF EXISTS so any partial prior state is tolerated.
-- Migration 007 created:
--   idx_apex_meeting_transcripts_file_id      (UNIQUE, column: file_id)
--   idx_apex_meeting_transcripts_owner        (column: owner_user_id)
--   idx_apex_meeting_transcripts_recorded_at  (column: recorded_at DESC)
ALTER INDEX IF EXISTS idx_apex_meeting_transcripts_file_id
  RENAME TO idx_instinct_meeting_transcripts_file_id;
ALTER INDEX IF EXISTS idx_apex_meeting_transcripts_owner
  RENAME TO idx_instinct_meeting_transcripts_owner;
ALTER INDEX IF EXISTS idx_apex_meeting_transcripts_recorded_at
  RENAME TO idx_instinct_meeting_transcripts_recorded_at;

-- =========================================================================
-- Compat-view updatability assertion.
--
-- The backward-compat view created above is supposed to be auto-updatable
-- (simple passthrough SELECT * FROM ...) so any legacy code reference
-- INSERTing / UPDATEing / DELETEing via apex_meeting_transcripts still
-- propagates to the renamed underlying table. plaud.ts has multiple
-- INSERT paths (rejection path + happy path upsert) hitting this table,
-- so updatable-AND-insertable is non-negotiable.
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
      AND table_name = 'apex_meeting_transcripts'
  ) THEN
    SELECT v.is_updatable, v.is_insertable_into
      INTO is_updatable, is_insertable
      FROM information_schema.views v
      WHERE v.table_schema = current_schema()
        AND v.table_name = 'apex_meeting_transcripts';

    IF is_updatable != 'YES' THEN
      RAISE EXCEPTION 'Compat view apex_meeting_transcripts is NOT updatable (is_updatable=%). Legacy code UPDATEs/DELETEs would silently fail. Aborting.', is_updatable;
    END IF;
    IF is_insertable != 'YES' THEN
      RAISE EXCEPTION 'Compat view apex_meeting_transcripts is NOT insertable (is_insertable_into=%). Legacy code INSERTs would silently fail. Aborting.', is_insertable;
    END IF;
    RAISE NOTICE 'Compat view apex_meeting_transcripts is fully R/W (is_updatable=%, is_insertable_into=%).', is_updatable, is_insertable;
  END IF;
END $$;

COMMIT;
