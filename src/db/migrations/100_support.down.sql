-- 100_support.down.sql — reversible teardown of 100.
--
-- Drops both support tables + their indexes. IF EXISTS everywhere so the
-- down migration is safe to re-run.
--
-- WARNING: this drops the support ticket history AND the curated pattern
-- library along with any feedback-driven success_count/fail_count edits.
-- Run only when the support feature is fully retired.

BEGIN;

DROP INDEX IF EXISTS idx_support_patterns_enabled;
DROP TABLE IF EXISTS instinct_support_patterns;

DROP INDEX IF EXISTS idx_support_tickets_created_at;
DROP INDEX IF EXISTS idx_support_tickets_created_by;
DROP INDEX IF EXISTS idx_support_tickets_status;
DROP TABLE IF EXISTS instinct_support_tickets;

COMMIT;
