-- 189_recommendation_pr.sql: link an automation recommendation to the
-- review-gated remediation PR opened for it. Additive + idempotent.

BEGIN;

ALTER TABLE instinct_automation_recommendations
  ADD COLUMN IF NOT EXISTS pr_url TEXT,
  ADD COLUMN IF NOT EXISTS pr_opened_at TIMESTAMPTZ;

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'instinct_automation_recommendations'
       AND column_name IN ('pr_url','pr_opened_at')
  ) = 2, 'instinct_automation_recommendations missing pr columns';
END $$;

COMMIT;
