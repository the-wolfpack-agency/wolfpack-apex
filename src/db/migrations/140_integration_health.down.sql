-- Down for migration 140 — integration_health.

BEGIN;

DROP VIEW IF EXISTS integration_health_latest;
DROP INDEX IF EXISTS integration_health_drift_idx;
DROP INDEX IF EXISTS integration_health_workspace_vendor_idx;
DROP TABLE IF EXISTS integration_health;

COMMIT;
