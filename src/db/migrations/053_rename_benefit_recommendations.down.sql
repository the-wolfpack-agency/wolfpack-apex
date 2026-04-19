-- Reverse of 053_rename_benefit_recommendations.sql. Safe to run against
-- any state: every statement guarded with IF EXISTS.

BEGIN;

DROP VIEW IF EXISTS apex_benefit_recommendations;

ALTER INDEX IF EXISTS idx_instinct_benefit_recs_doc
  RENAME TO idx_apex_benefit_recs_doc;

ALTER TABLE IF EXISTS instinct_benefit_recommendations
  RENAME TO apex_benefit_recommendations;

CREATE OR REPLACE VIEW instinct_benefit_recommendations AS
  SELECT * FROM apex_benefit_recommendations;

COMMIT;
