-- 210_ai_surfaces.sql
--
-- AI SURFACE INVENTORY — the durable record of every discovered AI touchpoint.
--
-- "You cannot govern what you cannot see." The shadow-AI discovery scan
-- (src/lib/ai-surface/*) finds every LLM SDK call, hardcoded provider endpoint,
-- and AI key in a client's source and persists each as a row here, workspace-
-- scoped, so the inventory is a TIME SERIES (surfaces appear/disappear as the
-- codebase changes) and the "ungoverned AI" gap is trackable over time. This is
-- the foundation the other AI-governance surfaces (input/context, memory,
-- code-gov, MCP, continuous eval) register into - each adds a new `kind`.
--
-- id is a deterministic TEXT key "ais_<hash>" over (workspace, target, kind,
-- provider, location) so a re-scan UPSERTs (refreshing last_seen_at) instead of
-- duplicating. workspace_id is TEXT (opaque slugs, never UUID), matching the
-- platform-scan / ogiam family. Workspace-scoped, so the repo-wide
-- tenant-isolation guardrail covers it.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + guarded indexes. RLS enabled with a
-- permissive (deny-by-default tripwire) policy, mirroring migration 207-209.
-- Paired 210_ai_surfaces.down.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_ai_surfaces (
  id            TEXT         PRIMARY KEY,
  workspace_id  TEXT         NOT NULL,
  -- The scanned target (repo / platform identifier).
  target        TEXT         NOT NULL,
  -- ai_sdk | provider_endpoint | api_key | ai_route (and future surface kinds).
  kind          TEXT         NOT NULL,
  -- Normalized provider slug (openai | anthropic | google | ... | unknown).
  provider      TEXT,
  -- file:line (static) or a route path.
  location      TEXT         NOT NULL,
  -- False until the touchpoint is proven to route through a governance layer.
  governed      BOOLEAN      NOT NULL DEFAULT false,
  risk          TEXT         NOT NULL,
  evidence      JSONB        NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT instinct_ai_surfaces_risk_chk
    CHECK (risk IN ('low', 'medium', 'high', 'critical'))
);

-- Inventory reads are per (workspace, target), newest activity first.
CREATE INDEX IF NOT EXISTS idx_ai_surfaces_workspace_target
  ON instinct_ai_surfaces (workspace_id, target);
-- "ungoverned AI" gap query: workspace-scoped, filter governed=false.
CREATE INDEX IF NOT EXISTS idx_ai_surfaces_workspace_governed
  ON instinct_ai_surfaces (workspace_id, governed);

-- Deny-by-default RLS tripwire + permissive policy, mirroring migration 207-209.
ALTER TABLE instinct_ai_surfaces ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_ai_surfaces_all ON instinct_ai_surfaces;
CREATE POLICY instinct_ai_surfaces_all ON instinct_ai_surfaces
  FOR ALL USING (true) WITH CHECK (true);

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'instinct_ai_surfaces'
       AND column_name IN ('id','workspace_id','target','kind','provider','location','governed','risk','evidence','first_seen_at','last_seen_at')
  ) = 11, 'instinct_ai_surfaces missing expected columns';

  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_ai_surfaces' AND column_name = 'id'
  ) = 'text', 'instinct_ai_surfaces.id must be TEXT';

  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_ai_surfaces' AND column_name = 'workspace_id'
  ) = 'text', 'instinct_ai_surfaces.workspace_id must be TEXT';

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_ai_surfaces'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
      AND c.relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'RLS not enabled on instinct_ai_surfaces - aborting migration 210.';
  END IF;
END $$;

COMMIT;
