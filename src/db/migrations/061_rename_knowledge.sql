-- Tier 4 DB rename: apex_knowledge → instinct_knowledge
--
-- Sibling migrations in this batch:
--   062 — apex_team_members → instinct_team_members
--   063 — apex_share_tokens → instinct_share_tokens
--   064 — apex_documents → instinct_documents
--   065 — apex_conversations → instinct_conversations
--   066 — apex_messages → instinct_messages
--   067 — apex_site_projects → instinct_site_projects
--   068 — apex_site_brief_edits → instinct_site_brief_edits
--   069 — apex_site_brief_generations → instinct_site_brief_generations
--   070 — apex_site_deploys → instinct_site_deploys
--   071 — apex_site_domains → instinct_site_domains
--   072 — apex_site_assets → instinct_site_assets
--   073 — apex_site_approvals → instinct_site_approvals
--   074 — apex_site_form_submissions → instinct_site_form_submissions
--   075 — apex_site_image_generations → instinct_site_image_generations
--   076 — apex_events → instinct_events
--
-- Pattern: same as 036/043/046/051 — defensive DO block covering all 6
-- pre-existing states (fresh DB, already-renamed, alias-view present, etc.),
-- row-count invariant, backward-compat view for soft-fallback on any missed
-- code reference, compat-view updatability assertion.

BEGIN;

DO $$
DECLARE
  apex_exists_as_table BOOLEAN;
  instinct_kind CHAR;
  pre_rename_count BIGINT := NULL;
  post_rename_count BIGINT;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'apex_knowledge' AND c.relkind = 'r' AND n.nspname = current_schema()
  ) INTO apex_exists_as_table;

  SELECT c.relkind INTO instinct_kind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_knowledge' AND n.nspname = current_schema() LIMIT 1;

  IF apex_exists_as_table THEN
    EXECUTE 'SELECT COUNT(*) FROM apex_knowledge' INTO pre_rename_count;
  ELSIF instinct_kind = 'r' THEN
    EXECUTE 'SELECT COUNT(*) FROM instinct_knowledge' INTO pre_rename_count;
  END IF;

  -- Drop any dependent aggregate/learning views so ALTER TABLE RENAME succeeds.


  IF instinct_kind = 'r' AND NOT apex_exists_as_table THEN
    EXECUTE 'CREATE OR REPLACE VIEW apex_knowledge AS SELECT * FROM instinct_knowledge';
    RAISE NOTICE 'Already renamed; ensured compat view apex_knowledge exists.';
  ELSIF apex_exists_as_table AND instinct_kind = 'v' THEN
    EXECUTE 'DROP VIEW instinct_knowledge';
    EXECUTE 'ALTER TABLE apex_knowledge RENAME TO instinct_knowledge';
    EXECUTE 'CREATE OR REPLACE VIEW apex_knowledge AS SELECT * FROM instinct_knowledge';
    RAISE NOTICE 'Renamed apex_knowledge → instinct_knowledge; compat view created.';
  ELSIF apex_exists_as_table AND instinct_kind IS NULL THEN
    EXECUTE 'ALTER TABLE apex_knowledge RENAME TO instinct_knowledge';
    EXECUTE 'CREATE OR REPLACE VIEW apex_knowledge AS SELECT * FROM instinct_knowledge';
    RAISE NOTICE 'Renamed apex_knowledge → instinct_knowledge (no pre-existing alias); compat view created.';
  ELSIF instinct_kind IS NOT NULL AND instinct_kind NOT IN ('r', 'v') THEN
    RAISE EXCEPTION 'Refusing to proceed: instinct_knowledge exists as relkind=% — manual inspection required.', instinct_kind;
  ELSIF NOT apex_exists_as_table AND instinct_kind = 'v' THEN
    EXECUTE 'DROP VIEW instinct_knowledge';
    RAISE NOTICE 'Dropped orphan view instinct_knowledge; apex_knowledge absent.';
  ELSE
    RAISE NOTICE 'Neither apex_knowledge nor instinct_knowledge exists; nothing to rename.';
  END IF;

  IF pre_rename_count IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT COUNT(*) FROM instinct_knowledge' INTO post_rename_count;
    EXCEPTION WHEN undefined_table THEN post_rename_count := NULL;
    END;
    IF post_rename_count IS NOT NULL AND post_rename_count != pre_rename_count THEN
      RAISE EXCEPTION 'Row-count mismatch after rename: pre=% post=%', pre_rename_count, post_rename_count;
    END IF;
    RAISE NOTICE 'Row-count assertion passed: % rows preserved.', COALESCE(pre_rename_count, 0);
  END IF;

  -- Recreate any aggregate/learning views that were dropped above, now
  -- pointing at the renamed table.

END $$;

-- Rename commonly-suffixed indexes (all guarded with IF EXISTS — fresh DBs,
-- partial rollback states, already-renamed DBs all tolerated).
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT indexname FROM pg_indexes
    WHERE schemaname = current_schema() AND indexname LIKE 'idx_apex_knowledge_%'
  LOOP
    EXECUTE format('ALTER INDEX %I RENAME TO %I', r.indexname,
                    replace(r.indexname, 'idx_apex_knowledge_', 'idx_instinct_knowledge_'));
  END LOOP;
END $$;

-- Compat-view R/W assertion: any legacy INSERT/UPDATE/DELETE via the old
-- name must propagate to the renamed table. Abort if the rewriter disagrees.
DO $$
DECLARE
  is_updatable TEXT;
  is_insertable TEXT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.views
    WHERE table_schema = current_schema() AND table_name = 'apex_knowledge'
  ) THEN
    SELECT v.is_updatable, v.is_insertable_into INTO is_updatable, is_insertable
      FROM information_schema.views v
      WHERE v.table_schema = current_schema() AND v.table_name = 'apex_knowledge';
    IF is_updatable != 'YES' THEN
      RAISE EXCEPTION 'Compat view apex_knowledge not updatable (is_updatable=%)', is_updatable;
    END IF;
    IF is_insertable != 'YES' THEN
      RAISE EXCEPTION 'Compat view apex_knowledge not insertable (is_insertable_into=%)', is_insertable;
    END IF;
    RAISE NOTICE 'Compat view apex_knowledge fully R/W.';
  END IF;
END $$;

COMMIT;
