-- 213_ai_redteam_runs.sql
--
-- CONTINUOUS AI RED-TEAM LEDGER - every adversarial sweep of the gate, recorded.
--
-- The red-team (src/lib/ai-redteam/*) runs a standing corpus of hostile agent
-- actions through the real OGIAM gate and records the result. The healthy state
-- is zero vulns (the gate blocks every attack); a vuln means a policy regression
-- let an attack through. Persisting each run, workspace-scoped, gives a durable
-- assurance trail + a learning signal (the loop watches pass_rate over time and
-- which categories ever slip). The cron run also alerts on any vuln.
--
-- id is a deterministic TEXT key "art_<hash>"; workspace_id is TEXT (opaque
-- slugs, never UUID), matching the ai-surface / ogiam family. Workspace-scoped,
-- so the repo-wide tenant-isolation guardrail covers it.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + guarded index. RLS enabled with a
-- permissive (deny-by-default tripwire) policy, mirroring migration 207-212.
-- Paired 213_ai_redteam_runs.down.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_ai_redteam_runs (
  id            TEXT         PRIMARY KEY,
  workspace_id  TEXT         NOT NULL,
  attacks_run   INT          NOT NULL DEFAULT 0,
  blocked       INT          NOT NULL DEFAULT 0,
  vulns         INT          NOT NULL DEFAULT 0,
  pass_rate     NUMERIC      NOT NULL DEFAULT 1,
  -- The vuln findings (empty in the healthy state).
  findings      JSONB        NOT NULL DEFAULT '[]'::jsonb,
  -- 'low' when clean, 'critical' when any attack got through (a gate regression).
  risk          TEXT         NOT NULL DEFAULT 'low',
  -- 'cron' | 'manual'.
  source        TEXT         NOT NULL DEFAULT 'cron',
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT instinct_ai_redteam_runs_risk_chk
    CHECK (risk IN ('low', 'medium', 'high', 'critical'))
);

-- History read: per workspace, newest first.
CREATE INDEX IF NOT EXISTS idx_ai_redteam_runs_workspace_created
  ON instinct_ai_redteam_runs (workspace_id, created_at DESC);

-- Deny-by-default RLS tripwire + permissive policy, mirroring migration 207-212.
ALTER TABLE instinct_ai_redteam_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_ai_redteam_runs_all ON instinct_ai_redteam_runs;
CREATE POLICY instinct_ai_redteam_runs_all ON instinct_ai_redteam_runs
  FOR ALL USING (true) WITH CHECK (true);

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'instinct_ai_redteam_runs'
       AND column_name IN ('id','workspace_id','attacks_run','blocked','vulns','pass_rate','findings','risk','source','created_at')
  ) = 10, 'instinct_ai_redteam_runs missing expected columns';

  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_ai_redteam_runs' AND column_name = 'id'
  ) = 'text', 'instinct_ai_redteam_runs.id must be TEXT';

  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_ai_redteam_runs' AND column_name = 'workspace_id'
  ) = 'text', 'instinct_ai_redteam_runs.workspace_id must be TEXT';

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_ai_redteam_runs'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
      AND c.relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'RLS not enabled on instinct_ai_redteam_runs - aborting migration 213.';
  END IF;
END $$;

COMMIT;
