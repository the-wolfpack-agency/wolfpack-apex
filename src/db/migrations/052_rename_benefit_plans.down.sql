-- Reverse of 052_rename_benefit_plans.sql. Reverses the table rename,
-- the two secondary index renames, AND the backward-compat view. Safe
-- to run against any state: every statement is guarded with IF EXISTS.
--
-- Post-rollback schema matches pre-052 schema exactly:
-- apex_benefit_plans is the table, instinct_benefit_plans is the
-- migration-014 alias view.

BEGIN;

-- 1. Drop the backward-compat view first so the old name is free for the table.
DROP VIEW IF EXISTS apex_benefit_plans;

-- 2. Secondary indexes back to apex_* names.
ALTER INDEX IF EXISTS idx_instinct_benefit_plans_premium
  RENAME TO idx_apex_benefit_plans_premium;
ALTER INDEX IF EXISTS idx_instinct_benefit_plans_doc
  RENAME TO idx_apex_benefit_plans_doc;

-- 3. Table back to its original name.
ALTER TABLE IF EXISTS instinct_benefit_plans RENAME TO apex_benefit_plans;

-- 4. Restore the migration-014 alias view so post-rollback schema
--    matches pre-052 schema exactly.
CREATE OR REPLACE VIEW instinct_benefit_plans AS
  SELECT * FROM apex_benefit_plans;

COMMIT;
