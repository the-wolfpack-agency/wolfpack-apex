-- Down migration for 200_sweep_runs_ux_kind.sql.
--
-- Restores the 2-value kind CHECK constraint (198's state). Any rows with
-- kind = 'ux' must be removed/converted first, or the re-added constraint will
-- reject them. No columns are dropped (200 added none). Idempotent.

BEGIN;

ALTER TABLE instinct_sweep_runs
  DROP CONSTRAINT IF EXISTS instinct_sweep_runs_kind_chk;

ALTER TABLE instinct_sweep_runs
  ADD CONSTRAINT instinct_sweep_runs_kind_chk
  CHECK (kind IN ('engagement', 'pentest'));

COMMENT ON COLUMN instinct_sweep_runs.kind IS
  'Which continuous sweep produced this run: engagement | pentest.';

COMMIT;
