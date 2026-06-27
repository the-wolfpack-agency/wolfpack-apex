-- Down migration for 197_workspace_offboarding_log.sql.
-- Drops the offboarding ledger table + its index. Idempotent.

BEGIN;

DROP INDEX IF EXISTS idx_workspace_offboarding_ws_purged;
DROP TABLE IF EXISTS instinct_workspace_offboarding_log;

COMMIT;
