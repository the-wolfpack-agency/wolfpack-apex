-- 123_principle_observations_cleanup.sql — full observations reset.
--
-- Two related production issues with `instinct_principle_observations`:
--
--   1. The on-edit re-evaluator + non-snapped observed_at on rollups
--      accumulated thousands of duplicate rows before migration 122
--      and the snap fix landed.
--   2. Team-wide validators (goals.kr_*, code.pr_cycle_time_under)
--      previously fanned out per user; the new emit-with-null pattern
--      coexists with the OLD per-user rows in the DB, double-counting
--      every team-wide signal under each member's count.
--
-- Cleanest production fix: drop every observation and let the next
-- cron tick (or a manual "Run now") repopulate against the corrected
-- code. Observations are pure derived data — no source-of-truth loss.
-- The migration also re-asserts the natural-key UNIQUE index (no-op
-- if 122 already created it) so future inserts are idempotent.
--
-- Safe to re-run.

BEGIN;

-- 1. Idempotent re-assert of the natural-key index — guards going forward.
CREATE UNIQUE INDEX IF NOT EXISTS uq_principle_observations_natural_key
  ON instinct_principle_observations (
       principle_id,
       validator_id,
       COALESCE(subject_user_id, ''),
       COALESCE(surface_subtype, ''),
       (date_trunc('minute', observed_at)),
       COALESCE(evidence_jsonb->>'sourceId', '')
  );

-- 2. Full reset of accumulated rows. Pure derived data; the next cron
--    run rebuilds clean against the current evaluators (snapped
--    observed_at, team-wide subject_user_id=null, ON CONFLICT guard).
TRUNCATE TABLE instinct_principle_observations;

-- 3. Sanity assertion.
DO $$
DECLARE
  obs_count INT;
BEGIN
  SELECT COUNT(*) INTO obs_count FROM instinct_principle_observations;
  ASSERT obs_count = 0, format('truncate failed: %s rows remain', obs_count);
END $$;

COMMIT;
