-- Down migration for 205_cross_scan_insights.sql.
-- Drops the cross-scan insights ledger, its indexes, and its RLS policy.
-- Idempotent.

BEGIN;

DROP POLICY IF EXISTS instinct_cross_scan_insights_all ON instinct_cross_scan_insights;
DROP INDEX IF EXISTS idx_cross_scan_insights_generated_at;
DROP INDEX IF EXISTS idx_cross_scan_insights_key;
DROP TABLE IF EXISTS instinct_cross_scan_insights;

COMMIT;
