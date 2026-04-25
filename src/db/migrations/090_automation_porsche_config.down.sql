-- 090_automation_porsche_config.down.sql — paired rollback for migration
-- 090. Drops the operator config table.
--
-- Down migrations are best-effort idempotent (IF EXISTS) so running them
-- on a partially-applied or already-rolled-back database doesn't error.

BEGIN;

DROP TABLE IF EXISTS instinct_automation_porsche_config;

COMMIT;
