-- Down migration for 206_cross_scan_insights_tenancy.sql.
--
-- Reverses the tenancy fix: drops the composite UNIQUE(workspace_id, key) index,
-- the workspace_id lookup index, and the workspace_id column, then RESTORES the
-- 205 single-column UNIQUE index on `key` so the schema returns to its pre-206
-- shape (the store's ON CONFLICT (key) would work again under that revision).
-- Idempotent.

BEGIN;

DROP INDEX IF EXISTS idx_cross_scan_insights_ws_key;
DROP INDEX IF EXISTS idx_cross_scan_insights_workspace;

ALTER TABLE instinct_cross_scan_insights
  DROP COLUMN IF EXISTS workspace_id;

-- Restore the 205 single-column dedup guard.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cross_scan_insights_key
  ON instinct_cross_scan_insights (key);

COMMIT;
