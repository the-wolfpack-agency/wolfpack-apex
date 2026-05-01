-- 115_user_nav_prefs.sql — per-user customization of the dashboard left nav.
--
-- Lets each Instinct user hide nav entries they don't use ("Sites",
-- "QR Codes", etc.) so their sidebar stays focused. Stored as an array
-- of hidden hrefs because that's the natural identity of a NAV_ITEM
-- (label changes, href is stable).
--
-- One row per user. Empty array (default) = show all nav items, which
-- preserves current behavior for every existing user.
--
-- Defensive guards (per memory feedback_migration_safety):
--   * BEGIN / COMMIT.
--   * IF NOT EXISTS guards.
--   * Final structural assertion DO block.
--   * Paired .down.sql.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS instinct_user_nav_prefs (
  user_id       TEXT PRIMARY KEY,
  hidden_hrefs  TEXT[] NOT NULL DEFAULT '{}',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_nav_prefs_updated
  ON instinct_user_nav_prefs (updated_at DESC);

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'instinct_user_nav_prefs'
       AND column_name IN ('user_id', 'hidden_hrefs', 'updated_at')
  ) = 3, 'instinct_user_nav_prefs missing expected columns';
END $$;

COMMIT;
