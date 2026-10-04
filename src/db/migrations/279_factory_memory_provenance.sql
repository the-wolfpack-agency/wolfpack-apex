-- Factory brain: per-handoff MEMORY PROVENANCE - which memories the brain gave a
-- run that produced a PR, so a later merge/reject can reinforce/decay exactly
-- those memories' confidence (the credit-assignment the reinforcement driver needs).
--
-- Keyed by approval_id (unique per handoff + only exists for runs that open a PR),
-- NOT the run ref (which is a shared label like 'factory' and would mis-attribute).
-- The reinforcement path joins pr_opened.approval_id -> these rows -> confidence.
-- Additive + idempotent.
CREATE TABLE IF NOT EXISTS instinct_factory_memory_provenance (
  workspace_id TEXT        NOT NULL DEFAULT 'default',
  approval_id  TEXT        NOT NULL,
  repo         TEXT        NOT NULL DEFAULT '',
  kind         TEXT        NOT NULL,   -- 'reuse' (mem_key = path) | 'failure' (mem_key = signature)
  mem_key      TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, approval_id, kind, mem_key)
);
CREATE INDEX IF NOT EXISTS idx_factory_provenance_approval
  ON instinct_factory_memory_provenance (workspace_id, approval_id);
