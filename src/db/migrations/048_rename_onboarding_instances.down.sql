-- Reverse of 048_rename_onboarding_instances.sql. Reverses the table +
-- index rename AND the backward-compat view. Safe to run against any
-- state: every statement is guarded with IF EXISTS.
--
-- Post-rollback schema matches pre-048 schema exactly:
-- apex_onboarding_instances is the table, instinct_onboarding_instances
-- is the migration-014 alias view.
--
-- The FK from apex_onboarding_instances(template_id) → templates(id)
-- survives this rollback untouched: Postgres tracks FKs by OID, not
-- name, and ALTER TABLE RENAME preserves the OID. The parent table is
-- whatever name migration 046 left it at; no FK maintenance needed here.

BEGIN;

-- 1. Drop the backward-compat view first so the old name is free for the table.
DROP VIEW IF EXISTS apex_onboarding_instances;

-- 2. Indexes back to apex_* names.
ALTER INDEX IF EXISTS idx_instinct_onboarding_employee RENAME TO idx_apex_onboarding_employee;
ALTER INDEX IF EXISTS idx_instinct_onboarding_status   RENAME TO idx_apex_onboarding_status;

-- 3. Table back to its original name.
ALTER TABLE IF EXISTS instinct_onboarding_instances RENAME TO apex_onboarding_instances;

-- 4. Restore the migration-014 alias view so post-rollback schema
--    matches pre-048 schema exactly.
CREATE OR REPLACE VIEW instinct_onboarding_instances AS
  SELECT * FROM apex_onboarding_instances;

COMMIT;
