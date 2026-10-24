-- Down migration for 294_sweep_runs_no_targets_status.sql.
--
-- Restores the 3-value status CHECK constraint (198's state). Rows with
-- status = 'no_targets' would violate it, so they are first relabelled 'ok',
-- the value the pre-294 code recorded for the same tick. Idempotent.

BEGIN;

UPDATE instinct_sweep_runs SET status = 'ok' WHERE status = 'no_targets';

ALTER TABLE instinct_sweep_runs
  DROP CONSTRAINT IF EXISTS instinct_sweep_runs_status_chk;

ALTER TABLE instinct_sweep_runs
  ADD CONSTRAINT instinct_sweep_runs_status_chk
  CHECK (status IN ('ok', 'partial', 'failed'));

COMMENT ON COLUMN instinct_sweep_runs.status IS
  'Derived health of this run: ok | partial | failed.';

COMMIT;
