-- Migration 176: OGIAM action outcomes (the RESULT half of the audit trail).
--
-- The ogiam_decisions ledger (append-only, hash-chained) captures the INPUT of
-- every governed action: who proposed it, the redacted params, the signals, the
-- deterministic decision, and the tamper-evident hashes. The missing half is the
-- RESULT: what actually happened when the authorized action ran. This table
-- records each executed action's redacted, truncated outcome, linked to its
-- decision by (workspace_id, decision_seq), so the per-agent trail can show the
-- full prompt-to-response detail.
--
-- Separate, append-only table by design: the decision row and its hash chain are
-- never mutated to attach an outcome (that would break tamper evidence). An
-- outcome is an independent fact appended after execution. There is no update
-- path. Additive and idempotent.

CREATE TABLE IF NOT EXISTS ogiam_action_outcomes (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    TEXT         NOT NULL,
  -- Links to ogiam_decisions.seq for this workspace (the decision this outcome
  -- is the result of). Not a hard FK: the ledger write is best-effort and the
  -- outcome write must never be coupled to it.
  decision_seq    BIGINT       NOT NULL,
  agent_id        TEXT,
  ok              BOOLEAN      NOT NULL,
  -- "ok" on success, else the ToolFailure code (validation, capability, ...).
  code            TEXT,
  -- The redacted + hard-truncated result string. Same redactor the ledger
  -- applies to params; never raw secrets or PII, capped in the writer.
  result_redacted TEXT,
  duration_ms     INTEGER,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Join an outcome to its decision (the trail query), workspace-scoped.
CREATE INDEX IF NOT EXISTS idx_ogiam_action_outcomes_decision
  ON ogiam_action_outcomes (workspace_id, decision_seq);

-- Per-agent recent outcomes (the agent profile view).
CREATE INDEX IF NOT EXISTS idx_ogiam_action_outcomes_agent
  ON ogiam_action_outcomes (agent_id, created_at DESC);
