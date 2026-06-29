-- 212_ai_code_reviews.sql
--
-- AI-CODE GOVERNANCE LEDGER - every AI-authored diff gated, with its verdict.
--
-- The code gate (src/lib/ai-code/*) scans an AI-authored diff before it merges
-- and a deterministic policy returns allow / escalate / block. Each review is
-- recorded here, workspace-scoped, so there is a durable, queryable history of
-- what AI-written code introduced and how the gate ruled (the learning loop mines
-- this for the patterns AI tools keep introducing). The verdict itself is also
-- written to the tamper-evident audit log by the route.
--
-- id is a deterministic TEXT key "acr_<hash>"; workspace_id is TEXT (opaque
-- slugs, never UUID), matching the ai-surface / ogiam family. Workspace-scoped,
-- so the repo-wide tenant-isolation guardrail covers it.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + guarded index. RLS enabled with a
-- permissive (deny-by-default tripwire) policy, mirroring migration 207-210.
-- Paired 212_ai_code_reviews.down.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_ai_code_reviews (
  id               TEXT         PRIMARY KEY,
  workspace_id     TEXT         NOT NULL,
  -- The change under review (PR number, branch, or commit label).
  ref              TEXT         NOT NULL,
  -- What authored the code (an agent id, "copilot", "cursor", etc.).
  author           TEXT,
  -- allow | escalate | block.
  outcome          TEXT         NOT NULL,
  highest_severity TEXT,
  finding_count    INT          NOT NULL DEFAULT 0,
  findings         JSONB        NOT NULL DEFAULT '[]'::jsonb,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT instinct_ai_code_reviews_outcome_chk
    CHECK (outcome IN ('allow', 'escalate', 'block'))
);

-- History read: per workspace, newest first.
CREATE INDEX IF NOT EXISTS idx_ai_code_reviews_workspace_created
  ON instinct_ai_code_reviews (workspace_id, created_at DESC);

-- Deny-by-default RLS tripwire + permissive policy, mirroring migration 207-210.
ALTER TABLE instinct_ai_code_reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_ai_code_reviews_all ON instinct_ai_code_reviews;
CREATE POLICY instinct_ai_code_reviews_all ON instinct_ai_code_reviews
  FOR ALL USING (true) WITH CHECK (true);

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'instinct_ai_code_reviews'
       AND column_name IN ('id','workspace_id','ref','author','outcome','highest_severity','finding_count','findings','created_at')
  ) = 9, 'instinct_ai_code_reviews missing expected columns';

  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_ai_code_reviews' AND column_name = 'id'
  ) = 'text', 'instinct_ai_code_reviews.id must be TEXT';

  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_ai_code_reviews' AND column_name = 'workspace_id'
  ) = 'text', 'instinct_ai_code_reviews.workspace_id must be TEXT';

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_ai_code_reviews'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
      AND c.relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'RLS not enabled on instinct_ai_code_reviews - aborting migration 212.';
  END IF;
END $$;

COMMIT;
