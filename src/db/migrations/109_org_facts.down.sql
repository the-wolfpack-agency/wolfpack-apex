-- 109_org_facts.down.sql — reverse 109_org_facts.sql.
BEGIN;

DROP INDEX IF EXISTS idx_org_facts_active;
DROP INDEX IF EXISTS idx_org_facts_attribute;
DROP INDEX IF EXISTS idx_org_facts_subject_normalized;
DROP TABLE IF EXISTS instinct_org_facts;

COMMIT;
