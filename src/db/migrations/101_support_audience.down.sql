-- 101_support_audience.down.sql — reversible teardown of 101.
--
-- Removes the audience column, its check constraint, and the supporting
-- index. IF EXISTS everywhere so the down migration is safe to re-run.
--
-- WARNING: this drops the audience routing signal — any ticket created
-- after this column was introduced will lose its client/internal flag.

BEGIN;

DROP INDEX IF EXISTS idx_support_tickets_audience;

ALTER TABLE instinct_support_tickets
  DROP CONSTRAINT IF EXISTS instinct_support_tickets_audience_chk;

ALTER TABLE instinct_support_tickets
  DROP COLUMN IF EXISTS audience;

COMMIT;
