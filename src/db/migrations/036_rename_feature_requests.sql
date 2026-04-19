-- Tier 4 DB rename PILOT: apex_feature_requests → instinct_feature_requests
--
-- First table of the apex_* → instinct_* schema sweep. Kept deliberately
-- narrow (one table, one migration) so the pattern can be validated by
-- the full test suite before the remaining 35 tables are renamed.
--
-- Strategy:
--   1. DROP the pass-through alias view `instinct_feature_requests`
--      (created by migration 014) — it becomes a recursive reference the
--      moment we rename the underlying table to the same name.
--   2. ALTER TABLE RENAME. PostgreSQL rewrites the other dependent views
--      (v_automation_opportunities from 002, v_features_by_product from
--      001) automatically because views reference tables by OID, not
--      name. Only the pass-through alias needs manual handling.
--   3. Rename the three indexes to match so `\d instinct_feature_requests`
--      output reads cleanly. Idempotent — IF EXISTS guards.
--
-- No code references other tables or views in this migration, so
-- rollback via 036.down.sql is a pure inverse. No data migration, no
-- downtime — this is a pg metadata operation.

BEGIN;

DROP VIEW IF EXISTS instinct_feature_requests;

ALTER TABLE IF EXISTS apex_feature_requests RENAME TO instinct_feature_requests;

ALTER INDEX IF EXISTS idx_apex_features_status RENAME TO idx_instinct_features_status;
ALTER INDEX IF EXISTS idx_apex_features_submitted_by RENAME TO idx_instinct_features_submitted_by;
ALTER INDEX IF EXISTS idx_apex_features_product RENAME TO idx_instinct_features_product;

COMMIT;
