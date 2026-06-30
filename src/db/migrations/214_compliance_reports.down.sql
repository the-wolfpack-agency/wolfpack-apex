-- Down migration for 214_compliance_reports.sql.
-- Drops the compliance evidence ledger, its index, and its RLS policy. Idempotent.

BEGIN;

DROP POLICY IF EXISTS instinct_compliance_reports_all ON instinct_compliance_reports;
DROP INDEX IF EXISTS idx_compliance_reports_workspace_created;
DROP TABLE IF EXISTS instinct_compliance_reports;

COMMIT;
