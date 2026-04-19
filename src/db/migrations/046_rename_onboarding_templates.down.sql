-- Reverse of 046_rename_onboarding_templates.sql. Reverses the table
-- rename AND the backward-compat view. Safe to run against any state:
-- every statement is guarded with IF EXISTS.
--
-- Post-rollback schema matches pre-046 schema exactly:
-- apex_onboarding_templates is the table, instinct_onboarding_templates
-- is the migration-014 alias view.
--
-- The FK from apex_onboarding_instances(template_id) → templates(id)
-- survives this rollback untouched: Postgres tracks FKs by OID, not
-- name, and ALTER TABLE RENAME preserves the OID.

BEGIN;

-- 1. Drop the backward-compat view first so the old name is free for the table.
DROP VIEW IF EXISTS apex_onboarding_templates;

-- 2. Table back to its original name.
ALTER TABLE IF EXISTS instinct_onboarding_templates RENAME TO apex_onboarding_templates;

-- 3. Restore the migration-014 alias view so post-rollback schema
--    matches pre-046 schema exactly.
CREATE OR REPLACE VIEW instinct_onboarding_templates AS
  SELECT * FROM apex_onboarding_templates;

COMMIT;
