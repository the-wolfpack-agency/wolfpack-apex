-- 206_cross_scan_insights_tenancy.sql
--
-- CROSS-SCAN INSIGHTS tenancy fix - close a cross-tenant leak (FIX 2).
--
-- Migration 205 created instinct_cross_scan_insights with a UNIQUE index on `key`
-- alone. The store's dedup key is `kind::platform::route::...` with NO tenant in
-- it, so two workspaces that scan the same platform/route produce the SAME key.
-- Under `ON CONFLICT (key) DO UPDATE`, workspace B then OVERWROTE workspace A's
-- row, and the unfiltered read served one tenant's insight to another. Both a
-- data-loss bug and a cross-tenant leak.
--
-- This migration is ADDITIVE (never edit 205; it may already be applied):
--   1. ADD COLUMN workspace_id TEXT (nullable; no backfill needed - legacy rows
--      keep NULL and the store deliberately never serves a NULL-workspace row to
--      any tenant, so they cannot leak).
--   2. DROP the single-column UNIQUE index/constraint on `key` (guarded - it may
--      be a plain UNIQUE INDEX from 205) and ADD a composite UNIQUE(workspace_id,
--      key) so the store's ON CONFLICT (workspace_id, key) dedups PER TENANT.
--   3. Index workspace_id for the tenant-scoped dashboard read.
--   4. RLS policy unchanged (205's permissive deny-by-default tripwire stays).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, DROP ... IF EXISTS, CREATE INDEX IF NOT
-- EXISTS. Paired 206_cross_scan_insights_tenancy.down.sql. Guarded ASSERTs at the
-- end verify the column + composite index exist and RLS is still on.

BEGIN;

-- 1. Tenant column. Additive + nullable: no backfill, legacy rows keep NULL.
ALTER TABLE instinct_cross_scan_insights
  ADD COLUMN IF NOT EXISTS workspace_id TEXT;

-- 2a. Drop the old single-column dedup guard from 205. It may have been created
--     either as a UNIQUE INDEX (205 uses CREATE UNIQUE INDEX) or, defensively, as
--     a table constraint - drop both shapes idempotently so the migration is
--     robust regardless of how 205 landed.
DROP INDEX IF EXISTS idx_cross_scan_insights_key;
ALTER TABLE instinct_cross_scan_insights
  DROP CONSTRAINT IF EXISTS idx_cross_scan_insights_key;
ALTER TABLE instinct_cross_scan_insights
  DROP CONSTRAINT IF EXISTS instinct_cross_scan_insights_key_key;

-- 2b. New TENANT-SCOPED dedup guard. ON CONFLICT (workspace_id, key) in the store
--     needs exactly this composite UNIQUE so a re-run UPSERTS the SAME tenant's
--     logical insight while a different tenant's identical key is a distinct row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cross_scan_insights_ws_key
  ON instinct_cross_scan_insights (workspace_id, key);

-- 3. Hot lookup for the tenant-scoped dashboard read (WHERE workspace_id = $1).
CREATE INDEX IF NOT EXISTS idx_cross_scan_insights_workspace
  ON instinct_cross_scan_insights (workspace_id);

-- RLS is left exactly as 205 set it (permissive deny-by-default tripwire); no
-- change needed here. Re-assert it is still ON below.

DO $$
BEGIN
  -- workspace_id column must exist and be TEXT.
  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_cross_scan_insights' AND column_name = 'workspace_id'
  ) = 'text', 'instinct_cross_scan_insights.workspace_id must exist and be TEXT';

  -- The composite tenant-scoped UNIQUE index must exist.
  ASSERT (
    SELECT COUNT(*) FROM pg_indexes
     WHERE tablename = 'instinct_cross_scan_insights'
       AND indexname = 'idx_cross_scan_insights_ws_key'
  ) = 1, 'composite UNIQUE(workspace_id, key) index missing - cross-tenant dedup not enforced';

  -- The old single-column key index must be GONE (else it would still let one
  -- tenant collide with another on key alone).
  ASSERT (
    SELECT COUNT(*) FROM pg_indexes
     WHERE tablename = 'instinct_cross_scan_insights'
       AND indexname = 'idx_cross_scan_insights_key'
  ) = 0, 'old single-column key index still present - cross-tenant leak not closed';

  -- RLS must still be ON - a silent NOOP would defeat the tripwire.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_cross_scan_insights'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
      AND c.relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'RLS not enabled on instinct_cross_scan_insights - aborting migration 206.';
  END IF;
END $$;

COMMIT;
