-- 103_support_categorization.down.sql — reversible teardown of 103.
--
-- Drops the CHECK constraint then the three categorization columns.
-- IF EXISTS everywhere so the down migration is safe to re-run.
--
-- WARNING: this drops the per-ticket category_history audit trail. After
-- a down + up cycle the AI confidence + source signal is gone for
-- already-classified tickets. Existing free-text `category` is
-- preserved so the UI keeps rendering correctly.

BEGIN;

ALTER TABLE instinct_support_tickets
  DROP CONSTRAINT IF EXISTS instinct_support_tickets_category_source_chk;

ALTER TABLE instinct_support_tickets
  DROP COLUMN IF EXISTS category_history;

ALTER TABLE instinct_support_tickets
  DROP COLUMN IF EXISTS category_confidence;

ALTER TABLE instinct_support_tickets
  DROP COLUMN IF EXISTS category_source;

COMMIT;
