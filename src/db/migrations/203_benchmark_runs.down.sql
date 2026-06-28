-- Down migration for 203_benchmark_runs.sql.
-- Drops the active-learning benchmark ledger, its index, and its RLS policy.
-- Idempotent.

BEGIN;

DROP POLICY IF EXISTS instinct_benchmark_runs_all ON instinct_benchmark_runs;
DROP INDEX IF EXISTS idx_benchmark_runs_run_at;
DROP TABLE IF EXISTS instinct_benchmark_runs;

COMMIT;
