-- 124_principle_observations_resnap.sql — second cleanup pass.
--
-- Two related issues that landed in production after migration 123:
--
--   1. focus_block_ratio still produced 2 rows per Dallas day because
--      the evaluator iterated UTC instants + 24h, which crossed the
--      same Dallas day twice when windowStart was offset from UTC
--      midnight. Each iteration produced a different observed_at (via
--      snapToOrgDay derived from the iteration instant) and slipped
--      past the unique natural-key index.
--
--   2. meeting_outcome_logged rows persisted from BEFORE the
--      scoreOutcome tier fix landed (substantial bodies without
--      markers should score 0 / neutral, not -0.3 / drift). The
--      Run-all throttle prevented re-emission.
--
-- The application-side fix lands in the same deploy as this migration
-- (focus-block now walks Dallas calendar dates directly + the cool-
-- down was reduced). This migration TRUNCATEs so the next Run all
-- repopulates against the corrected code.
--
-- Idempotent — safe to re-run.

BEGIN;

TRUNCATE TABLE instinct_principle_observations;

DO $$
DECLARE
  obs_count INT;
BEGIN
  SELECT COUNT(*) INTO obs_count FROM instinct_principle_observations;
  ASSERT obs_count = 0, format('truncate failed: %s rows remain', obs_count);
END $$;

COMMIT;
