-- Reverse of 054_rename_benefit_documents.sql. Safe to run against any
-- state: every statement guarded with IF EXISTS.

BEGIN;

DROP VIEW IF EXISTS apex_benefit_documents;

-- Migration 010 created no secondary indexes on this table.

ALTER TABLE IF EXISTS instinct_benefit_documents
  RENAME TO apex_benefit_documents;

CREATE OR REPLACE VIEW instinct_benefit_documents AS
  SELECT * FROM apex_benefit_documents;

COMMIT;
