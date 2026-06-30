-- 214_compliance_reports.sql
--
-- COMPLIANCE EVIDENCE LEDGER - every generated framework report, recorded.
--
-- The compliance engine (src/lib/compliance/*) crosswalks OGIAM's live controls
-- to SOC2 / ISO 42001 / NIST AI RMF / EU AI Act and derives a covered/partial/gap
-- status from MEASURED evidence (audit chain, gate decisions, red-team pass rate,
-- the ungoverned-AI gap). Each generated report is persisted here, workspace-
-- scoped, so coverage is a time series (the learning loop watches it climb) and a
-- past report is reproducible evidence for an auditor.
--
-- id is a deterministic TEXT key "cmp_<hash>"; workspace_id is TEXT (opaque slugs,
-- never UUID), matching the ai-surface / ogiam family. Workspace-scoped, so the
-- repo-wide tenant-isolation guardrail covers it.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + guarded index. RLS enabled with a
-- permissive (deny-by-default tripwire) policy, mirroring migration 207-213.
-- Paired 214_compliance_reports.down.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_compliance_reports (
  id            TEXT         PRIMARY KEY,
  workspace_id  TEXT         NOT NULL,
  framework     TEXT         NOT NULL,
  coverage      NUMERIC      NOT NULL DEFAULT 0,
  covered       INT          NOT NULL DEFAULT 0,
  partial       INT          NOT NULL DEFAULT 0,
  gap           INT          NOT NULL DEFAULT 0,
  -- The full per-control report (status + evidence string per control).
  report        JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT instinct_compliance_reports_framework_chk
    CHECK (framework IN ('SOC2', 'ISO42001', 'NIST_AI_RMF', 'EU_AI_ACT'))
);

-- History read: per workspace, newest first.
CREATE INDEX IF NOT EXISTS idx_compliance_reports_workspace_created
  ON instinct_compliance_reports (workspace_id, created_at DESC);

-- Deny-by-default RLS tripwire + permissive policy, mirroring migration 207-213.
ALTER TABLE instinct_compliance_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_compliance_reports_all ON instinct_compliance_reports;
CREATE POLICY instinct_compliance_reports_all ON instinct_compliance_reports
  FOR ALL USING (true) WITH CHECK (true);

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'instinct_compliance_reports'
       AND column_name IN ('id','workspace_id','framework','coverage','covered','partial','gap','report','created_at')
  ) = 9, 'instinct_compliance_reports missing expected columns';

  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_compliance_reports' AND column_name = 'id'
  ) = 'text', 'instinct_compliance_reports.id must be TEXT';

  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_compliance_reports' AND column_name = 'workspace_id'
  ) = 'text', 'instinct_compliance_reports.workspace_id must be TEXT';

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_compliance_reports'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
      AND c.relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'RLS not enabled on instinct_compliance_reports - aborting migration 214.';
  END IF;
END $$;

COMMIT;
