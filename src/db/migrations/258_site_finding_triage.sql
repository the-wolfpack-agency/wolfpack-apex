-- Triage state for Site Analytics agent-journey findings. Lets an operator
-- acknowledge, escalate, or dismiss a finding so the triage board becomes a
-- workflow with memory, not just a view. Workspace-scoped. No PII: the
-- finding_key is the opaque journey correlation key, never a person.

CREATE TABLE IF NOT EXISTS instinct_site_finding_triage (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT        NOT NULL,
  finding_key  TEXT        NOT NULL,          -- the journey correlation key (opaque)
  status       TEXT        NOT NULL,          -- new | acknowledged | escalated | dismissed
  note         TEXT,
  updated_by   TEXT        NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT site_finding_triage_status_chk CHECK (status IN ('new', 'acknowledged', 'escalated', 'dismissed')),
  CONSTRAINT site_finding_triage_uniq UNIQUE (workspace_id, finding_key)
);

CREATE INDEX IF NOT EXISTS idx_site_finding_triage_ws_updated
  ON instinct_site_finding_triage (workspace_id, updated_at DESC);
