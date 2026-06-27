-- Down for migration 194. Drops the coverage index + columns added to the
-- platform-scan header. Idempotent (IF EXISTS); reversing only removes the
-- accounting columns, the scan rows themselves stand.
BEGIN;

DROP INDEX IF EXISTS idx_platform_scans_coverage;

ALTER TABLE instinct_platform_scans
  DROP COLUMN IF EXISTS attempted_routes,
  DROP COLUMN IF EXISTS succeeded_routes,
  DROP COLUMN IF EXISTS errored_routes,
  DROP COLUMN IF EXISTS auth_established,
  DROP COLUMN IF EXISTS coverage_ratio;

COMMIT;
