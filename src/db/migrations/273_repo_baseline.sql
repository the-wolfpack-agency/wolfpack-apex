-- Onboarding baseline snapshot for a client's repository.
--
-- "Baseline the project before testing" - a recorded snapshot of a repo's CI
-- check state at the moment the client connects, so pre-existing failures are
-- documented UP FRONT and never mistaken for something the factory introduced.
-- CI baseline attribution (ci-status.ts) can compare a change against this
-- recorded baseline, not just the live base-branch read that may have drifted.
--
-- One row per (workspace_id, repo): re-baselining is an intentional upsert (a new
-- known-good starting point), so the latest snapshot is the baseline.
CREATE TABLE IF NOT EXISTS instinct_repo_baseline (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   TEXT         NOT NULL,
  repo           TEXT         NOT NULL,          -- "owner/name"
  default_branch TEXT,
  -- The raw check runs captured, as returned by GitHub (name/status/conclusion).
  checks         JSONB        NOT NULL DEFAULT '[]'::jsonb,
  total_count    INTEGER      NOT NULL DEFAULT 0,
  failing_count  INTEGER      NOT NULL DEFAULT 0,
  failing_checks TEXT[]       NOT NULL DEFAULT '{}',
  captured_by    TEXT,
  captured_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT uq_instinct_repo_baseline_workspace_repo UNIQUE (workspace_id, repo)
);
CREATE INDEX IF NOT EXISTS idx_instinct_repo_baseline_workspace
  ON instinct_repo_baseline (workspace_id, captured_at DESC);
