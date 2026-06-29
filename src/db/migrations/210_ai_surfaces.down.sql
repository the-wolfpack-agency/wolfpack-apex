-- Down migration for 210_ai_surfaces.sql.
-- Drops the AI surface inventory, its indexes, and its RLS policy. Idempotent.

BEGIN;

DROP POLICY IF EXISTS instinct_ai_surfaces_all ON instinct_ai_surfaces;
DROP INDEX IF EXISTS idx_ai_surfaces_workspace_governed;
DROP INDEX IF EXISTS idx_ai_surfaces_workspace_target;
DROP TABLE IF EXISTS instinct_ai_surfaces;

COMMIT;
