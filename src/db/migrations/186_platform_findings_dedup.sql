-- Migration 186 — de-duplicate platform-scan findings + enforce identity.
--
-- recordScan inserted a fresh row for every finding on every run, so re-scanning
-- a platform piled up identical findings ("tons of errors" in the review UI). A
-- finding's identity is (workspace_id, platform, route, title); a re-scan should
-- UPDATE that one row, not create a new one. This migration (1) collapses the
-- existing duplicates, keeping the most-triaged + oldest of each group so review
-- state (resolved/acknowledged) is preserved, then (2) adds the unique index that
-- backs the ON CONFLICT upsert in recordScan.

BEGIN;

-- 1. Collapse duplicates. Keep one row per identity: prefer resolved >
--    acknowledged > open (so human triage survives), then the oldest.
DELETE FROM instinct_platform_scan_findings
 WHERE id IN (
   SELECT id FROM (
     SELECT id,
            ROW_NUMBER() OVER (
              PARTITION BY workspace_id, platform, route, title
              ORDER BY CASE status
                         WHEN 'resolved' THEN 0
                         WHEN 'acknowledged' THEN 1
                         ELSE 2 END,
                       created_at
            ) AS rn
       FROM instinct_platform_scan_findings
   ) ranked
   WHERE ranked.rn > 1
 );

-- 2. Identity index — backs ON CONFLICT (workspace_id, platform, route, title).
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_findings_identity
  ON instinct_platform_scan_findings (workspace_id, platform, route, title);

COMMIT;
