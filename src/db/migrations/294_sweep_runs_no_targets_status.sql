-- Migration 294 - widen instinct_sweep_runs.status to include 'no_targets'.
--
-- Why this exists: a continuous sweep tick that assessed NOTHING (zero targets,
-- or every target skipped for a non-error reason) used to be recorded 'ok' and
-- fire platform.sweep_completed, so a sweep that had never assessed a single
-- target looked identical to a healthy one. src/lib/platform-scan/sweep-health.ts
-- now records such a tick as 'no_targets' and fires platform.sweep_no_targets.
-- The 198 table pinned status to ('ok','partial','failed') via a named CHECK, so
-- that CHECK must be widened before a 'no_targets' row can be written.
--
-- Safe on live data: widening a CHECK accepts every existing row (all of them
-- hold one of the three original values). No columns are added or dropped, no
-- rows are touched. Idempotent: drop + re-add the NAMED constraint (mirrors 200's
-- widening of the kind CHECK), so a re-run is a no-op in effect.

BEGIN;

ALTER TABLE instinct_sweep_runs
  DROP CONSTRAINT IF EXISTS instinct_sweep_runs_status_chk;

ALTER TABLE instinct_sweep_runs
  ADD CONSTRAINT instinct_sweep_runs_status_chk
  CHECK (status IN ('ok', 'partial', 'failed', 'no_targets'));

COMMENT ON COLUMN instinct_sweep_runs.status IS
  'Derived health of this run: ok (every target assessed) | partial (some failed or skipped, some assessed) | failed (all failed, or the sweep threw) | no_targets (nothing assessed: zero targets or all skipped).';

COMMIT;
