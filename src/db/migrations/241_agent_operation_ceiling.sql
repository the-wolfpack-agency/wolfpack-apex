-- What stops an agent running away.
--
-- An agent has a role, an accountable owner and a lifecycle state, so a human
-- can pause or revoke one. Nothing stopped it on its own. A misbehaving agent
-- ran until somebody noticed, and "somebody notices" is not a control a
-- corporation can be asked to rely on: it is the thing they are buying us to
-- replace.
--
-- A ceiling is per agent rather than per workspace on purpose. A workspace
-- budget is shared, so one runaway agent spends everybody else's allowance
-- before it trips anything, and the first symptom is unrelated work failing.
--
-- Sixty an hour by default: comfortably above what a real task needs and far
-- below what a loop produces. Set to 0 to mean unlimited, which is a decision
-- somebody has to make explicitly rather than the default they inherit.
ALTER TABLE instinct_agents
  ADD COLUMN IF NOT EXISTS max_operations_per_hour INT NOT NULL DEFAULT 60;

-- Every operation an agent actually executed, so the ceiling is counted from
-- what happened rather than from what was intended.
CREATE TABLE IF NOT EXISTS instinct_agent_operations (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT        NOT NULL,
  agent_id     UUID        NOT NULL,
  operation    TEXT        NOT NULL,
  -- Recorded whether it ran or was refused, because a refusal that is not
  -- counted is a ceiling somebody can walk through by retrying.
  outcome      TEXT        NOT NULL,
  executed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The count is always "this agent, this hour", so the index is that query.
CREATE INDEX IF NOT EXISTS instinct_agent_operations_window_idx
  ON instinct_agent_operations (agent_id, executed_at DESC);

CREATE INDEX IF NOT EXISTS instinct_agent_operations_workspace_idx
  ON instinct_agent_operations (workspace_id, executed_at DESC);
