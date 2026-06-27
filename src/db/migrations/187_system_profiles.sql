-- 187_system_profiles.sql: the agent's persisted knowledge model of a target
-- platform (SystemProfile). One row per (workspace_id, platform); the profiler
-- upserts so re-profiling replaces the row. The full structured profile lives in
-- `profile` (JSONB); the scalar columns are denormalized for fast list/sort and
-- trend queries without parsing JSON.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS instinct_system_profiles (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       TEXT NOT NULL DEFAULT 'default',
  platform           TEXT NOT NULL,
  profile            JSONB NOT NULL DEFAULT '{}'::jsonb,
  entity_count       INTEGER NOT NULL DEFAULT 0,
  integration_count  INTEGER NOT NULL DEFAULT 0,
  route_count        INTEGER NOT NULL DEFAULT 0,
  critical_count     INTEGER NOT NULL DEFAULT 0,
  generated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_system_profiles_identity UNIQUE (workspace_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_system_profiles_ws_generated
  ON instinct_system_profiles (workspace_id, generated_at DESC);

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'instinct_system_profiles'
       AND column_name IN ('id','workspace_id','platform','profile','entity_count','integration_count','route_count','critical_count','generated_at')
  ) = 9, 'instinct_system_profiles missing expected columns';
END $$;

COMMIT;
