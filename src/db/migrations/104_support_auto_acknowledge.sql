-- 104_support_auto_acknowledge.sql — auto-ack metadata for support tickets.
--
-- Adds the columns needed for the support@ auto-acknowledge feature:
--
-- On instinct_support_patterns:
--   * auto_acknowledge_enabled BOOLEAN — opt-in flag per pattern. Off by
--     default so a freshly-seeded pattern never auto-replies until an
--     operator explicitly turns it on.
--   * auto_acknowledge_template TEXT — a SAFER, narrower template than
--     the full draft template. Used as the STARTING POINT for the AI
--     auto-ack rephrase. The AI rewrites it to avoid asserting facts
--     about the user's specific account state.
--
-- On instinct_support_tickets:
--   * auto_acknowledged_at TIMESTAMPTZ — when the auto-ack was sent.
--     Null = no auto-ack was sent (either ticket pre-dated this feature
--     or the gate said no).
--   * auto_acknowledge_message_id TEXT — Graph message id of the sent
--     auto-ack reply. Used so operators can see the auto-ack in the
--     thread and so the learning loop can correlate auto-ack content
--     with eventual resolution.
--   * auto_acknowledge_pattern_id UUID — FK to the pattern that
--     produced the auto-ack. Lets the analytics layer roll up auto-ack
--     volume per pattern for the success_count / fail_count loop.
--
-- All columns are additive, defaulted (or nullable), and FK-checked so
-- existing rows stay valid without a backfill.
--
-- Defensive guards (per memory feedback_migration_safety):
--   * BEGIN / COMMIT wraps every statement.
--   * IF NOT EXISTS on column adds.
--   * Final DO block ASSERTs every new column + the FK constraint exists.
--   * Down migration drops in reverse order with IF EXISTS.

BEGIN;

ALTER TABLE instinct_support_patterns
  ADD COLUMN IF NOT EXISTS auto_acknowledge_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE instinct_support_patterns
  ADD COLUMN IF NOT EXISTS auto_acknowledge_template TEXT;

ALTER TABLE instinct_support_tickets
  ADD COLUMN IF NOT EXISTS auto_acknowledged_at TIMESTAMPTZ;

ALTER TABLE instinct_support_tickets
  ADD COLUMN IF NOT EXISTS auto_acknowledge_message_id TEXT;

ALTER TABLE instinct_support_tickets
  ADD COLUMN IF NOT EXISTS auto_acknowledge_pattern_id UUID;

-- ============================================================
-- FK on tickets.auto_acknowledge_pattern_id → patterns.id.
--
-- ON DELETE SET NULL so deleting an experimental pattern does not
-- cascade-blow-up the historical tickets it produced. The audit trail
-- (auto_acknowledged_at + message_id) survives independently.
--
-- Guarded with a NOT EXISTS on pg_constraint so re-running the
-- migration does not error on the second pass.
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'instinct_support_tickets_auto_ack_pattern_fk'
  ) THEN
    ALTER TABLE instinct_support_tickets
      ADD CONSTRAINT instinct_support_tickets_auto_ack_pattern_fk
      FOREIGN KEY (auto_acknowledge_pattern_id)
      REFERENCES instinct_support_patterns(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- ============================================================
-- Structure assertions (per memory feedback_migration_safety)
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'instinct_support_patterns'
      AND column_name = 'auto_acknowledge_enabled'
  ) THEN
    RAISE EXCEPTION 'auto_acknowledge_enabled column missing — aborting migration 104.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'instinct_support_patterns'
      AND column_name = 'auto_acknowledge_template'
  ) THEN
    RAISE EXCEPTION 'auto_acknowledge_template column missing — aborting migration 104.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'instinct_support_tickets'
      AND column_name = 'auto_acknowledged_at'
  ) THEN
    RAISE EXCEPTION 'auto_acknowledged_at column missing — aborting migration 104.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'instinct_support_tickets'
      AND column_name = 'auto_acknowledge_message_id'
  ) THEN
    RAISE EXCEPTION 'auto_acknowledge_message_id column missing — aborting migration 104.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'instinct_support_tickets'
      AND column_name = 'auto_acknowledge_pattern_id'
  ) THEN
    RAISE EXCEPTION 'auto_acknowledge_pattern_id column missing — aborting migration 104.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'instinct_support_tickets_auto_ack_pattern_fk'
  ) THEN
    RAISE EXCEPTION 'auto_ack_pattern_fk FK missing — aborting migration 104.';
  END IF;
  RAISE NOTICE '104_support_auto_acknowledge: 5 columns + 1 FK created.';
END $$;

COMMIT;
