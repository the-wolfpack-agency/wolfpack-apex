-- Down migration for 204_competitor_benchmark_runs.sql.
-- Drops the competitive benchmark ledger, its index, and its RLS policy.
-- Idempotent.

BEGIN;

DROP POLICY IF EXISTS instinct_competitor_benchmark_runs_all ON instinct_competitor_benchmark_runs;
DROP INDEX IF EXISTS idx_competitor_runs_run_at;
DROP TABLE IF EXISTS instinct_competitor_benchmark_runs;

COMMIT;
