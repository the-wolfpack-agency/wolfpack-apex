-- 103_support_categorization.sql — AI categorization metadata on support tickets.
--
-- Today every ticket carries `category` (free-text, defaulting to 'general').
-- The AI auto-categorizer (src/lib/support/categorizer.ts) needs three more
-- columns so we can:
--
--   * tell whether a category came from the operator or the AI
--     (`category_source`)
--   * record how confident the model was when it made the pick
--     (`category_confidence`) so the UI can surface a "?" indicator on
--     low-confidence rows and the learning loop can compute precision
--   * keep an append-only audit trail of every category change with
--     who/what/when (`category_history` JSONB array). The UI never
--     overwrites this — `setTicketCategory` in repo.ts always appends.
--
-- All columns are additive, defaulted, and CHECK-constrained where
-- relevant so existing rows stay valid without a backfill.
--
-- Defensive guards (per memory feedback_migration_safety):
--   * BEGIN / COMMIT wraps every statement.
--   * IF NOT EXISTS on column adds.
--   * Final DO block ASSERTs every new column + the CHECK constraint exists.
--   * Down migration drops in reverse order with IF EXISTS.

BEGIN;

ALTER TABLE instinct_support_tickets
  ADD COLUMN IF NOT EXISTS category_source TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE instinct_support_tickets
  ADD COLUMN IF NOT EXISTS category_confidence NUMERIC;

ALTER TABLE instinct_support_tickets
  ADD COLUMN IF NOT EXISTS category_history JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ============================================================
-- CHECK constraint on category_source.
--
-- Guarded with a NOT EXISTS so re-running the migration does not error
-- on the second pass (CREATE CONSTRAINT IF NOT EXISTS doesn't exist in
-- pg < 16, so we emulate it via the catalog lookup).
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'instinct_support_tickets_category_source_chk'
  ) THEN
    ALTER TABLE instinct_support_tickets
      ADD CONSTRAINT instinct_support_tickets_category_source_chk
      CHECK (category_source IN ('manual', 'ai'));
  END IF;
END $$;

-- ============================================================
-- Structure assertions (per memory feedback_migration_safety)
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'instinct_support_tickets'
      AND column_name = 'category_source'
  ) THEN
    RAISE EXCEPTION 'category_source column missing — aborting migration 103.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'instinct_support_tickets'
      AND column_name = 'category_confidence'
  ) THEN
    RAISE EXCEPTION 'category_confidence column missing — aborting migration 103.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'instinct_support_tickets'
      AND column_name = 'category_history'
  ) THEN
    RAISE EXCEPTION 'category_history column missing — aborting migration 103.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'instinct_support_tickets_category_source_chk'
  ) THEN
    RAISE EXCEPTION 'category_source CHECK constraint missing — aborting migration 103.';
  END IF;
  RAISE NOTICE '103_support_categorization: 3 columns + 1 check constraint created.';
END $$;

COMMIT;
