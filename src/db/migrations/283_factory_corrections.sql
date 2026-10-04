-- Factory brain #3, CORRECTION MEMORY: when a human edited the factory's PR before
-- merging, learn from the DELTA (what the human changed vs what the factory
-- authored). Recorded per handoff keyed by approval_id with the deterministic
-- correction CATEGORIES (tests / error-handling / imports / types / new-files /
-- removed-code / comments) + counts, so future authoring of the same task type can
-- be told "humans usually add X here" and a human-edit rate is visible.
--
-- SAFE BY CONSTRUCTION (the #4 rule): we store the ANALYSIS - category labels +
-- line counts - NEVER the delta code. Both inputs (the authored diff and the
-- merged diff) are gate-cleared / public; only the summary persists here.
-- Additive + idempotent.
CREATE TABLE IF NOT EXISTS instinct_factory_corrections (
  workspace_id  TEXT        NOT NULL DEFAULT 'default',
  approval_id   TEXT        NOT NULL,
  repo          TEXT        NOT NULL DEFAULT '',
  task_type     TEXT        NOT NULL DEFAULT 'other',
  edited        boolean     NOT NULL DEFAULT false,
  categories    TEXT[]      NOT NULL DEFAULT '{}',
  human_added   INT         NOT NULL DEFAULT 0,
  human_removed INT         NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, approval_id)
);
CREATE INDEX IF NOT EXISTS idx_factory_corrections_lookup
  ON instinct_factory_corrections (workspace_id, task_type, created_at DESC);
