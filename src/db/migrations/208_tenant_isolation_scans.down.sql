-- Down migration for 208_tenant_isolation_scans.sql.
-- Drops the tenant-isolation coverage ledger, its index, and its RLS policy.
-- Idempotent.

BEGIN;

DROP POLICY IF EXISTS instinct_tenant_isolation_scans_all ON instinct_tenant_isolation_scans;
DROP INDEX IF EXISTS idx_tenant_isolation_scans_observed_at;
DROP TABLE IF EXISTS instinct_tenant_isolation_scans;

COMMIT;
