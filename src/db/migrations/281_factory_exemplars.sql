-- Factory brain #10, EXEMPLARS: a POINTER to each factory change a human actually
-- MERGED - the strongest positive signal we have. Grounds future authoring in
-- "similar work that shipped" and records which model shipped it (compounds with
-- the reuse corpus + per-(model,task-type) grades).
--
-- SAFE BY CONSTRUCTION (the #4 rule): we store a reference + the prompt + the
-- model, NEVER the authored code. The merged PR is the source of truth and is
-- already gate-cleared and public, so this can never become a secret store.
--
-- Recorded at handoff keyed by approval_id (unique per handoff), promoted to
-- merged=true by the merge-poll - exactly the provenance/reinforcement pattern.
-- Additive + idempotent.
CREATE TABLE IF NOT EXISTS instinct_factory_exemplars (
  workspace_id TEXT        NOT NULL DEFAULT 'default',
  approval_id  TEXT        NOT NULL,
  repo         TEXT        NOT NULL DEFAULT '',
  task_type    TEXT        NOT NULL DEFAULT 'other',
  prompt       TEXT        NOT NULL DEFAULT '',
  model        TEXT        NOT NULL DEFAULT '',
  merged       boolean     NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  merged_at    TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, approval_id)
);
-- Retrieval is by (workspace, task_type) over merged exemplars, newest first.
CREATE INDEX IF NOT EXISTS idx_factory_exemplars_lookup
  ON instinct_factory_exemplars (workspace_id, task_type, merged, created_at DESC);
