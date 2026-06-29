-- Down migration for 212_ai_code_reviews.sql.
-- Drops the AI-code governance ledger, its index, and its RLS policy. Idempotent.

BEGIN;

DROP POLICY IF EXISTS instinct_ai_code_reviews_all ON instinct_ai_code_reviews;
DROP INDEX IF EXISTS idx_ai_code_reviews_workspace_created;
DROP TABLE IF EXISTS instinct_ai_code_reviews;

COMMIT;
