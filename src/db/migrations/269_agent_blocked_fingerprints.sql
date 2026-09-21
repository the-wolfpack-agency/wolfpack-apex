-- Distributed operator-block enforcement: the stable per-request fingerprints
-- (fp) of operators an admin has blocked from the board. The central ruleset
-- serves these so every connected site turns the operator away pre-emptively.
-- Non-PII: fp is a header-order hash, not identity. Rows are removed on unblock.
CREATE TABLE IF NOT EXISTS instinct_agent_blocked_fingerprints (
  workspace_id TEXT NOT NULL,
  operator_key TEXT NOT NULL,
  fp           TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, operator_key, fp)
);
CREATE INDEX IF NOT EXISTS idx_agent_blocked_fp_workspace
  ON instinct_agent_blocked_fingerprints (workspace_id);
