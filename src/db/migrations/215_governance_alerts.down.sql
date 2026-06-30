-- Down migration for 215_governance_alerts.sql.
-- Drops the governance alert dedupe ledger, its index, and its RLS policy. Idempotent.

BEGIN;

DROP POLICY IF EXISTS instinct_governance_alerts_all ON instinct_governance_alerts;
DROP INDEX IF EXISTS idx_governance_alerts_workspace_created;
DROP TABLE IF EXISTS instinct_governance_alerts;

COMMIT;
