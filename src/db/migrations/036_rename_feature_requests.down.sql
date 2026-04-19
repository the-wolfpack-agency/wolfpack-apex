-- Reverse of 036_rename_feature_requests.sql.
-- Recreates the pass-through alias view so legacy code that still reads
-- instinct_feature_requests as a view (rather than the renamed table)
-- continues to work after rollback. Safe to run against a fresh DB too
-- because every statement is guarded with IF EXISTS.

BEGIN;

ALTER INDEX IF EXISTS idx_instinct_features_product RENAME TO idx_apex_features_product;
ALTER INDEX IF EXISTS idx_instinct_features_submitted_by RENAME TO idx_apex_features_submitted_by;
ALTER INDEX IF EXISTS idx_instinct_features_status RENAME TO idx_apex_features_status;

ALTER TABLE IF EXISTS instinct_feature_requests RENAME TO apex_feature_requests;

CREATE OR REPLACE VIEW instinct_feature_requests AS
  SELECT * FROM apex_feature_requests;

COMMIT;
