-- Reverse of 059_rename_discussions.sql. Reverses the table + index rename
-- AND the backward-compat view AND the learning-view rebuild. Safe to run
-- against any state: every statement is guarded with IF EXISTS.
--
-- Post-rollback schema matches pre-059 schema exactly:
--   - apex_discussions is the table
--   - instinct_discussions is the migration-014 alias view
--   - v_discussion_velocity selects FROM apex_discussions + apex_discussion_replies
--
-- IMPORTANT: if 060_rename_discussion_replies has already run, the
-- `apex_discussion_replies` name in the rebuilt v_discussion_velocity
-- view resolves through the 060 compat view — which is exactly what we
-- want for rollback-in-isolation scenarios. A full-family rollback runs
-- 060.down first, which restores apex_discussion_replies as the real
-- table. Either ordering leaves the view pointing at a working relation.

BEGIN;

-- 1. Drop the dependent learning view so the RENAME can proceed —
--    same constraint as the forward migration, just in reverse.
DROP VIEW IF EXISTS v_discussion_velocity;

-- 2. Drop the backward-compat view so the old name is free for the table.
DROP VIEW IF EXISTS apex_discussions;

-- 3. Secondary indexes back to apex_* names.
ALTER INDEX IF EXISTS idx_instinct_discussions_created_by
  RENAME TO idx_apex_discussions_created_by;
ALTER INDEX IF EXISTS idx_instinct_discussions_status
  RENAME TO idx_apex_discussions_status;
ALTER INDEX IF EXISTS idx_instinct_discussions_category
  RENAME TO idx_apex_discussions_category;

-- 4. Table back to its original name.
ALTER TABLE IF EXISTS instinct_discussions RENAME TO apex_discussions;

-- 5. Restore the migration-014 alias view so post-rollback schema
--    matches pre-059 schema exactly.
CREATE OR REPLACE VIEW instinct_discussions AS
  SELECT * FROM apex_discussions;

-- 6. Restore the migration-002 learning view pointing at the original
--    table name. Only recreate if the underlying tables actually exist
--    (skip on databases that never had migrations 001/002 applied).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'apex_discussions'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
  ) THEN
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
      FROM apex_discussions d
      GROUP BY d.category$v$;
  END IF;
END $$;

COMMIT;
