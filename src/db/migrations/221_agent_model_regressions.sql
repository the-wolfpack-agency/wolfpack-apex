-- Migration 221: agent model-version regression ledger.
--
-- The founding pain this product exists to solve is "agents behave
-- inconsistently across model/agent-version changes." Behavior drift
-- (migration 175, src/lib/agents/drift/*) measures WHETHER an agent's governed
-- behavior shifted over time; it cannot say WHY. This table closes that gap for
-- the one cause the operator most needs to catch fast: a model bump.
--
-- The model-eval sweep (src/lib/agents/evals/store.ts) groups an agent's
-- agent.task_completed events by the model_id already stamped on each event,
-- computes the task-success rate per model, orders models by most-recent use,
-- and compares the newest model (candidate) against the previously-used model
-- (baseline). Holding the agent (and thus its task mix) fixed and varying only
-- the model across time attributes the success-rate delta to the model switch.
-- A row is written only for a meaningful verdict (regressed | improved), so this
-- is a signal ledger, not a per-sweep firehose. Workspace scoping is enforced in
-- the lib queries (WHERE workspace_id = $1), matching migration 175. Additive
-- and idempotent; paired down migration at 221_agent_model_regressions.down.sql.

CREATE TABLE IF NOT EXISTS instinct_agent_model_regressions (
  id                     UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id               TEXT             NOT NULL,
  workspace_id           TEXT             NOT NULL,
  -- The previously-used model (reference) and the newest model (under test).
  baseline_model         TEXT             NOT NULL,
  candidate_model        TEXT             NOT NULL,
  -- Task-success rates in [0,1] and their signed delta (candidate - baseline).
  -- A negative delta at/below the regression threshold is a model regression.
  baseline_success_rate  DOUBLE PRECISION NOT NULL,
  candidate_success_rate DOUBLE PRECISION NOT NULL,
  delta                  DOUBLE PRECISION NOT NULL,
  -- Sample sizes behind each rate, so a verdict is always explainable.
  baseline_samples       INTEGER          NOT NULL,
  candidate_samples      INTEGER          NOT NULL,
  -- 'regressed' or 'improved' (the only verdicts persisted).
  verdict                TEXT             NOT NULL,
  created_at             TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

-- Fleet-wide recent-regressions read (the agents ops panel).
CREATE INDEX IF NOT EXISTS idx_instinct_agent_model_regressions_workspace
  ON instinct_agent_model_regressions (workspace_id, created_at DESC);
-- Per-agent history read (the agent detail surface).
CREATE INDEX IF NOT EXISTS idx_instinct_agent_model_regressions_agent
  ON instinct_agent_model_regressions (agent_id, created_at DESC);
