-- 191_scan_targets.sql: stored client scan targets (full ScanManifest configs)
-- so a client system can be ONBOARDED without a code change. resolveScanTarget
-- consults: curated code manifests -> these stored targets -> connector creds.
-- One row per (workspace_id, platform); the onboarding flow upserts.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS instinct_scan_targets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL DEFAULT 'default',
  platform     TEXT NOT NULL,
  manifest     JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_by   TEXT NOT NULL DEFAULT 'system',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_scan_targets_identity UNIQUE (workspace_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_scan_targets_ws_active
  ON instinct_scan_targets (workspace_id, is_active);

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'instinct_scan_targets'
       AND column_name IN ('id','workspace_id','platform','manifest','is_active','created_by','created_at','updated_at')
  ) = 8, 'instinct_scan_targets missing expected columns';
END $$;

COMMIT;
