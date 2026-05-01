-- 119_principles_config.sql — single-row config table for the
-- principles platform. Replaces the env-var pair (PRINCIPLES_DOC_URL +
-- PRINCIPLES_DOC_OWNER_USER_ID) with a leadership-editable record so
-- setup is pure UI: paste URL once → click Sync.
--
-- Single row enforced by `singleton` BOOLEAN column = TRUE +
-- partial unique index. owner_user_id can be left NULL — the lib
-- auto-picks the first ceo/cto with a connected M365 token.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS instinct_principles_config (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton       BOOLEAN NOT NULL DEFAULT TRUE,
  doc_url         TEXT,
  owner_user_id   TEXT,
  updated_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT instinct_principles_config_singleton_chk CHECK (singleton = TRUE)
);

-- Singleton: only one row, ever.
CREATE UNIQUE INDEX IF NOT EXISTS uq_principles_config_singleton
  ON instinct_principles_config (singleton);

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'instinct_principles_config'
       AND column_name IN ('id','singleton','doc_url','owner_user_id','updated_by','created_at','updated_at')
  ) = 7, 'instinct_principles_config missing expected columns';
END $$;

COMMIT;
