-- Operator blocklist - operators an admin has judged hostile, blocked by their
-- durable fingerprint (not by IP or model, which they change at will). One row
-- per (workspace, operator_key). Enforced wherever we have operator context (a
-- probe run's sighting; a future edge integration reads this set), and surfaced
-- on the operators board so a block is a visible, reversible decision.

CREATE TABLE IF NOT EXISTS instinct_agent_operator_blocklist (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  TEXT        NOT NULL,
  operator_key  TEXT        NOT NULL,
  reason        TEXT,
  blocked_by    TEXT,
  blocked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT instinct_agent_operator_blocklist_uq UNIQUE (workspace_id, operator_key)
);

CREATE INDEX IF NOT EXISTS idx_operator_blocklist_ws
  ON instinct_agent_operator_blocklist (workspace_id);
