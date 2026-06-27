-- Migration 194 - platform-scan coverage accounting.
--
-- A scan that returns "0 findings" must be distinguishable from a scan that was
-- silently DEGRADED (auth session expired, half the routes errored). Today the
-- scan-header row records only route_count / finding_count, so a barely-completed
-- scan looks identical to a clean bill - a dangerous false-negative we could hand
-- a client as "secure". This migration persists per-run coverage on the existing
-- scan-header row so every scan carries an explicit trustworthiness signal.
--
-- Discrete columns (not a jsonb blob) deliberately: the table already records its
-- counts as discrete INTEGER columns (route_count, finding_count, critical_count),
-- so coverage matches that shape; discrete columns are directly aggregatable for
-- the learning loop ("what fraction of scans on platform X are degraded?") and the
-- boolean indexes cleanly, which a jsonb path would not. Additive + idempotent.
--
-- TEXT for any id columns (schema guard) - the table's workspace_id/triggered_by
-- are already TEXT; these new columns are numeric/boolean only.

BEGIN;

ALTER TABLE instinct_platform_scans
  ADD COLUMN IF NOT EXISTS attempted_routes INTEGER  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS succeeded_routes INTEGER  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS errored_routes   INTEGER  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auth_established  BOOLEAN,
  ADD COLUMN IF NOT EXISTS coverage_ratio    NUMERIC;

-- Hot lookup for the learning loop: "degraded scans for this workspace over time".
CREATE INDEX IF NOT EXISTS idx_platform_scans_coverage
  ON instinct_platform_scans (workspace_id, coverage_ratio);

COMMIT;
