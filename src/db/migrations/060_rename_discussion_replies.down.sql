-- Reverse of 060_rename_discussion_replies.sql. Reverses the table + index
-- rename AND the backward-compat view AND the learning-view rebuild. Safe
-- to run against any state: every statement is guarded with IF EXISTS.
--
-- Post-rollback schema matches pre-060 schema exactly:
--   - apex_discussion_replies is the table
--   - instinct_discussion_replies is the migration-014 alias view
--   - v_discussion_velocity selects FROM apex_discussion_replies
--
-- A full-family rollback runs 060.down first, then 059.down; after that
-- the schema is bit-for-bit pre-batch-5.

BEGIN;

-- 1. Drop the dependent learning view so the RENAME can proceed.
DROP VIEW IF EXISTS v_discussion_velocity;

-- 2. Drop the backward-compat view so the old name is free for the table.
DROP VIEW IF EXISTS apex_discussion_replies;

-- 3. Secondary indexes back to apex_* names.
ALTER INDEX IF EXISTS idx_instinct_discussion_replies_author
  RENAME TO idx_apex_replies_author;
ALTER INDEX IF EXISTS idx_instinct_discussion_replies_discussion
  RENAME TO idx_apex_replies_discussion;

-- 4. Table back to its original name.
ALTER TABLE IF EXISTS instinct_discussion_replies RENAME TO apex_discussion_replies;

-- 5. Restore the migration-014 alias view so post-rollback schema
--    matches pre-060 schema exactly.
CREATE OR REPLACE VIEW instinct_discussion_replies AS
  SELECT * FROM apex_discussion_replies;

-- 6. Restore the migration-002 learning view pointed at the original
--    table names. Resolve the parent-table name at rollback time: if
--    059 has already been rolled back, apex_discussions is the real
--    table; if not, apex_discussions is still the 059 compat view —
--    either works because both resolve to the same underlying rows.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'apex_discussion_replies'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
  ) AND EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'apex_discussions'
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
