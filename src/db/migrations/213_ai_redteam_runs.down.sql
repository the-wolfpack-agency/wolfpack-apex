-- Down migration for 213_ai_redteam_runs.sql.
-- Drops the AI red-team ledger, its index, and its RLS policy. Idempotent.

BEGIN;

DROP POLICY IF EXISTS instinct_ai_redteam_runs_all ON instinct_ai_redteam_runs;
DROP INDEX IF EXISTS idx_ai_redteam_runs_workspace_created;
DROP TABLE IF EXISTS instinct_ai_redteam_runs;

COMMIT;
