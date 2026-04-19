-- Reverse of 036_rename_feature_requests.sql. Reverses the table + index
-- rename AND the backward-compat view. Safe to run against any state:
-- every statement is guarded with IF EXISTS.

BEGIN;

-- 1. Drop the backward-compat view first so the old name is free for the table.
DROP VIEW IF EXISTS apex_feature_requests;

-- 2. Indexes back to apex_* names.
ALTER INDEX IF EXISTS idx_instinct_features_product     RENAME TO idx_apex_features_product;
ALTER INDEX IF EXISTS idx_instinct_features_submitted_by RENAME TO idx_apex_features_submitted_by;
ALTER INDEX IF EXISTS idx_instinct_features_status      RENAME TO idx_apex_features_status;

-- 3. Table back to its original name.
ALTER TABLE IF EXISTS instinct_feature_requests RENAME TO apex_feature_requests;

-- 4. Restore the migration-014 alias view so post-rollback schema
--    matches pre-036 schema exactly.
CREATE OR REPLACE VIEW instinct_feature_requests AS
  SELECT * FROM apex_feature_requests;

COMMIT;
