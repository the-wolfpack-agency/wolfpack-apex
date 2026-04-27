-- 101_support_audience.sql — add an `audience` column to support tickets.
--
-- Operators need to distinguish CLIENT-facing requests (a dealer principal
-- email) from INTERNAL Wolfpack-team requests (a teammate's OneDrive issue).
-- This drives:
--   * routing — replies go from different addresses
--     (support@thewolfpack.agency vs the operator's personal address)
--   * mental filtering — separate inboxes
--   * analytics — track client-vs-internal volume
--
-- Default is 'internal' so any pre-existing ticket continues to behave as
-- it did before this migration shipped.
--
-- Defensive guards (per memory feedback_migration_safety):
--   * BEGIN / COMMIT wraps every statement.
--   * IF NOT EXISTS on the column add + index.
--   * DO block guards the CHECK constraint so re-running is safe.
--   * Final DO block ASSERTs the column + check + index exist.
--   * Down migration drops in reverse order with IF EXISTS.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'instinct_support_tickets'
      AND column_name = 'audience'
  ) THEN
    ALTER TABLE instinct_support_tickets
      ADD COLUMN audience TEXT NOT NULL DEFAULT 'internal';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'instinct_support_tickets_audience_chk'
  ) THEN
    ALTER TABLE instinct_support_tickets
      ADD CONSTRAINT instinct_support_tickets_audience_chk
      CHECK (audience IN ('client', 'internal'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_support_tickets_audience
  ON instinct_support_tickets(audience);

-- ============================================================
-- Structure assertions
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'instinct_support_tickets'
      AND column_name = 'audience'
  ) THEN
    RAISE EXCEPTION 'audience column missing — aborting migration 101.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'instinct_support_tickets_audience_chk'
  ) THEN
    RAISE EXCEPTION 'audience CHECK constraint missing — aborting migration 101.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'idx_support_tickets_audience'
      AND n.nspname = current_schema()
  ) THEN
    RAISE EXCEPTION 'idx_support_tickets_audience missing — aborting migration 101.';
  END IF;
  RAISE NOTICE '101_support_audience: audience column + check + index created.';
END $$;

COMMIT;
