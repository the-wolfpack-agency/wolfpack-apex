-- 122_principle_observations_dedupe.sql — kill duplicate observations.
--
-- Symptom (2026-05-02): every focus_block_ratio row appearing twice
-- within ~15 seconds because two evaluation runs (the periodic cron +
-- the on-edit re-evaluator) both inserted with no idempotency.
--
-- Fix: a UNIQUE index on the natural key (principle, validator,
-- subject, subtype, observed_at, evidence sourceId).
--
-- IMPORTANT: Postgres requires every function used in an index
-- expression to be IMMUTABLE. `date_trunc('minute', timestamptz)` is
-- only STABLE (it depends on session timezone), so it cannot live in
-- a UNIQUE index expression and was rejected with 42P17 on the first
-- deploy attempt. We drop the truncation here and rely instead on the
-- application-side `snapToUtcDay` helper to make rollup observed_at
-- deterministic. Per-event observations dedupe via the evidence
-- `sourceId` field which is naturally unique per message/task/PR.
--
-- Pre-existing duplicates are deleted (keeping the lowest id per
-- natural key) before the index is created so the build doesn't
-- fail on existing data.

BEGIN;

-- 1. Remove pre-existing duplicates: keep the smallest id per natural key.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY principle_id,
                        validator_id,
                        COALESCE(subject_user_id, ''),
                        COALESCE(surface_subtype, ''),
                        observed_at,
                        COALESCE(evidence_jsonb->>'sourceId', '')
           ORDER BY id
         ) AS rn
    FROM instinct_principle_observations
)
DELETE FROM instinct_principle_observations o
 USING ranked r
 WHERE o.id = r.id
   AND r.rn > 1;

-- 2. UNIQUE index — application uses ON CONFLICT DO NOTHING against
--    this. All expressions are IMMUTABLE: COALESCE on a constant '' is
--    immutable, and observed_at is referenced directly.
CREATE UNIQUE INDEX IF NOT EXISTS uq_principle_observations_natural_key
  ON instinct_principle_observations (
       principle_id,
       validator_id,
       COALESCE(subject_user_id, ''),
       COALESCE(surface_subtype, ''),
       observed_at,
       COALESCE(evidence_jsonb->>'sourceId', '')
  );

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM pg_indexes
     WHERE indexname = 'uq_principle_observations_natural_key'
  ) = 1, 'uq_principle_observations_natural_key not created';
END $$;

COMMIT;
