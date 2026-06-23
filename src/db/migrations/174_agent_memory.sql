-- Migration 174: shared agent procedural memory (cumulative learning).
--
-- When an agent completes a task its plan becomes a candidate procedure
-- (goal -> the steps that worked), keyed by a normalized goal so a later agent
-- facing the same goal can reuse it instead of re-exploring. Candidates start
-- quarantined and are PROMOTED only after an adversarial safety check (each step
-- re-evaluated against the current OGIAM policy), so a poisoned or now-unsafe
-- procedure cannot propagate to other agents. Promoted procedures are the
-- inheritable memory; this is what plateaus AI cost across agents.
--
-- One entry per (workspace, goal_key); provenance records which agent learned
-- it and from which task. Additive and idempotent.

CREATE TABLE IF NOT EXISTS instinct_agent_memory (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     TEXT         NOT NULL,
  goal_key         TEXT         NOT NULL,
  goal             TEXT         NOT NULL,
  -- The plan that worked: [{ instruction, tool }].
  plan             JSONB        NOT NULL,
  -- quarantined (default), promoted (passed the safety check), rejected.
  status           TEXT         NOT NULL DEFAULT 'quarantined',
  learned_by_agent TEXT         NOT NULL,
  source_task_id   TEXT,
  -- How many times a later agent reused this promoted procedure.
  hit_count        INTEGER      NOT NULL DEFAULT 0,
  reject_reason    TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  verified_at      TIMESTAMPTZ,

  CONSTRAINT uq_instinct_agent_memory_ws_key UNIQUE (workspace_id, goal_key)
);

CREATE INDEX IF NOT EXISTS idx_instinct_agent_memory_ws_status
  ON instinct_agent_memory (workspace_id, status, created_at DESC);
