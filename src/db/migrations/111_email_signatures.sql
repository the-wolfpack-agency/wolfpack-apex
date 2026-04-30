-- 111_email_signatures.sql — per-user email signatures for the /emails composer.
--
-- Goal: when a user composes a new email, they should be able to insert a
-- saved signature ("Nick — CTO, Wolfpack Agency", "Demo prospect — short
-- variant", etc.) at the cursor, and have a default signature pre-filled
-- on a fresh compose. Replies/forwards insert ABOVE the quoted-original
-- block.
--
-- Shape:
--   user_id     — owning user (TEXT to match the rest of the codebase
--                 since 040_user_id_columns_to_text).
--   label       — short human label shown in the dropdown ("Default",
--                 "Long version", "Demo prospect", …).
--   body        — the signature text. Plain text or simple HTML; the
--                 composer escapes when inserting if needed.
--   is_default  — when true, this is the auto-prefill signature for
--                 fresh emails. AT MOST ONE row per user_id may have
--                 is_default=TRUE; lib/email-signatures.ts demotes
--                 prior defaults atomically inside a transaction.
--
-- Why a new table instead of stuffing this into instinct_user_prefs:
--   * Multiple signatures per user — preferences would force a single row.
--   * Independent CRUD lifecycle (label edits don't touch other prefs).
--   * Distinct learning signal: "signature_inserted" is its own analytics
--     event — see InstinctEventType union in src/lib/analytics.ts.
--
-- Defensive guards (per memory feedback_migration_safety):
--   * BEGIN / COMMIT wraps every statement.
--   * IF NOT EXISTS on the table + indexes.
--   * Final DO block ASSERTs structure.
--   * Paired .down.sql drops in reverse with IF EXISTS.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS instinct_email_signatures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  label TEXT NOT NULL,
  body TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot path: list-by-user, ordered with default first then most-recent.
CREATE INDEX IF NOT EXISTS idx_email_signatures_user_default
  ON instinct_email_signatures (user_id, is_default DESC, created_at DESC);

-- Partial unique index: at most one default signature per user.
-- Uses WHERE is_default to leave room for as many non-defaults as the user wants.
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_signatures_one_default_per_user
  ON instinct_email_signatures (user_id)
  WHERE is_default = TRUE;

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*)
      FROM information_schema.columns
     WHERE table_name = 'instinct_email_signatures'
       AND column_name IN (
         'id','user_id','label','body','is_default','created_at','updated_at'
       )
  ) = 7, 'instinct_email_signatures missing expected columns';
END $$;

COMMIT;
