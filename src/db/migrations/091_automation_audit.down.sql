-- 091_automation_audit.down.sql — reversible teardown of 091.
--
-- Drops the audit table + both supporting indexes. Safe to re-run because
-- of IF EXISTS everywhere.
--
-- WARNING: this drops the user-visible audit trail. There is no recovery
-- short of a DB restore. Run only when the audit feature is fully retired.

BEGIN;

DROP TABLE IF EXISTS instinct_automation_porsche_notifications;

DROP INDEX IF EXISTS idx_instinct_auto_audit_target_active;
DROP INDEX IF EXISTS idx_instinct_auto_audit_recent;
DROP TABLE IF EXISTS instinct_automation_audit_actions;

COMMIT;
