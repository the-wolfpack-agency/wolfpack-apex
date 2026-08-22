-- 232_assistant_routine_runs
--
-- One row per run of a routine, and one per step.
--
-- WHY THIS IS PERSISTED AT ALL
--
-- Not for replay, and not to show somebody what they already watched happen.
-- It is persisted for two columns: tech_ms and human_ms.
--
-- A routine stops at a human step. When it does, we know precisely when the
-- machine handed over and when the person handed back. Nothing else in the
-- estate knows that. Analytics can say a tool was called; a calendar can say a
-- meeting happened; neither can say that step four of the Monday review costs
-- eleven minutes of somebody's attention every week and that they have never
-- once changed what it produced.
--
-- With a month of these rows, three questions stop being opinions:
--   * which step do people always edit  -> the tool before it is wrong
--   * which step do people always wave through -> the pause can be deleted
--   * which routine gets abandoned halfway -> something in it is worse than
--     doing the job by hand
--
-- That is the audit chain between human and tech activity: not a log of what
-- the software did, but a measurement of where the person is still the
-- integration layer, ranked by what it costs them.
--
-- WHAT IS DELIBERATELY NOT STORED
--
-- Slot CONTENTS. A run carries mail bodies, customer history and draft replies
-- between its steps, and a table of those is a second copy of the mailbox with
-- none of the controls the mailbox has. Slots live for the life of the run in
-- the caller's hands; what lands here is which step ran, whether it worked,
-- how long it took, and whose time it was.
--
-- Idempotent. Paired rollback in 232_assistant_routine_runs.down.sql.

CREATE TABLE IF NOT EXISTS assistant_routine_runs (
  run_id        TEXT PRIMARY KEY,
  routine_id    TEXT        NOT NULL,
  user_id       TEXT        NOT NULL,
  workspace_id  TEXT        NOT NULL,
  state         TEXT        NOT NULL,
  -- Named step_cursor, not cursor: CURSOR is a SQL keyword, and a column
  -- that needs quoting forever to be read is a papercut on every future query.
  step_cursor   INTEGER     NOT NULL DEFAULT 0,
  -- Machine time and human time, kept apart. Summing them would hide the only
  -- number here worth acting on.
  tech_ms       BIGINT      NOT NULL DEFAULT 0,
  human_ms      BIGINT      NOT NULL DEFAULT 0,
  -- When the run stopped at a person. NULL when it is not waiting on anybody,
  -- so "nobody is holding this up" is a value rather than an inference.
  paused_at     TIMESTAMPTZ,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  CONSTRAINT assistant_routine_runs_state_chk
    CHECK (state IN ('running', 'waiting_for_human', 'done', 'failed'))
);

CREATE TABLE IF NOT EXISTS assistant_routine_steps (
  run_id      TEXT    NOT NULL REFERENCES assistant_routine_runs(run_id) ON DELETE CASCADE,
  -- Denormalised from the parent run ON PURPOSE. A child table reachable only
  -- through a join is one whose safety depends on every future query
  -- remembering to join, and the query that forgets is the one that leaks
  -- another company's step labels. Carrying the column costs a few bytes and
  -- makes this table scopable on its own terms.
  workspace_id TEXT   NOT NULL,
  step_index  INTEGER NOT NULL,
  kind        TEXT    NOT NULL,
  -- The tool a step ran, so "which tool is only ever reached from a routine"
  -- is answerable. NULL for model and human steps.
  tool        TEXT,
  label       TEXT    NOT NULL,
  status      TEXT    NOT NULL,
  -- For a tool or model step this is machine time. For a HUMAN step it is how
  -- long the person took, which is the row that makes the whole table useful.
  duration_ms BIGINT  NOT NULL DEFAULT 0,
  -- Why a step failed, in the words shown to the person. Never a stack, and
  -- never the data the step was carrying.
  error       TEXT,
  PRIMARY KEY (run_id, step_index),
  CONSTRAINT assistant_routine_steps_kind_chk
    CHECK (kind IN ('tool', 'model', 'human')),
  CONSTRAINT assistant_routine_steps_status_chk
    CHECK (status IN ('ok', 'failed', 'skipped', 'waiting'))
);

-- The two reads this table exists for: "what is waiting on me" (per user), and
-- "where does this routine cost time" (per routine).
CREATE INDEX IF NOT EXISTS assistant_routine_runs_user_idx
  ON assistant_routine_runs (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS assistant_routine_runs_routine_idx
  ON assistant_routine_runs (routine_id, started_at DESC);
-- Partial, because "who is being waited on right now" is a small slice of a
-- table that only grows.
CREATE INDEX IF NOT EXISTS assistant_routine_steps_workspace_idx
  ON assistant_routine_steps (workspace_id, run_id);
CREATE INDEX IF NOT EXISTS assistant_routine_runs_waiting_idx
  ON assistant_routine_runs (workspace_id, paused_at)
  WHERE state = 'waiting_for_human';

-- RLS on, matching the repo bar. Isolation is enforced app-side by an explicit
-- workspace_id predicate, consistent with sibling tables.
ALTER TABLE assistant_routine_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS assistant_routine_runs_all ON assistant_routine_runs;
CREATE POLICY assistant_routine_runs_all ON assistant_routine_runs
  FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE assistant_routine_steps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS assistant_routine_steps_all ON assistant_routine_steps;
CREATE POLICY assistant_routine_steps_all ON assistant_routine_steps
  FOR ALL USING (true) WITH CHECK (true);

-- Where a routine costs a person time. One row per step of per routine, with
-- the human wait separated from the machine work, so the "should this pause
-- exist" conversation starts from arithmetic.
CREATE OR REPLACE VIEW v_routine_step_cost AS
SELECT
  r.routine_id,
  s.step_index,
  s.kind,
  s.label,
  COUNT(*)                                              AS runs,
  COUNT(*) FILTER (WHERE s.status = 'failed')           AS failures,
  ROUND(AVG(s.duration_ms))                             AS avg_ms,
  ROUND(AVG(s.duration_ms) FILTER (WHERE s.kind = 'human')) AS avg_human_ms
FROM assistant_routine_steps s
JOIN assistant_routine_runs r ON r.run_id = s.run_id
GROUP BY r.routine_id, s.step_index, s.kind, s.label;
