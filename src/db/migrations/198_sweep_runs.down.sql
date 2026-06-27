-- Down migration for 198_sweep_runs.sql.
-- Drops the continuous-sweep observability ledger + its index. Idempotent.

BEGIN;

DROP INDEX IF EXISTS idx_sweep_runs_kind_started;
DROP TABLE IF EXISTS instinct_sweep_runs;

COMMIT;
